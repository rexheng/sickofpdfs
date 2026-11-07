// A scan's recognised words, read ahead of any mark (ruling R106). While the browser is idle, each recognised page on
// screen is read from its own full render (or base), once its picture and its text are both there:
// - first its plan (scan-ink's planInk, line by line): each word's paper and ink and its letters. From the letters come
//   the places where its chars meet (letterCuts), which the page text then uses for its char boxes, so the selection,
//   highlights, underlines, strikethroughs and bold all start and end on the same whole letters;
// - then, at the zoom shown, every word grown bold letter by letter (growLetters), so a bold mark only copies the px of
//   its letters onto the page's bold canvas at the key press, however many words it covers.
//
// Each step is done a line or a word at a time, inside the browser's idle time, so scrolling never waits on it. The plan
// is kept for the page (it is in points); the grown letters only for pages on screen, at the zoom (picture size) and
// weight they were made for, and are made again when either changes. Tiles are not read ahead: a bold mark on a tiled
// zoom grows its lines on the tiles as before.
import { useEffect } from 'react';
import type { PageGlyphs, PageSize } from '../backend/types';
import { growLetters, type GrownLetter, type InkWord, inkWordsOf, letterCuts, linesOf, markedWord, planInk, type PlannedWord } from '../marks/scan-ink';
import { pageToDevice } from '../marks/synthetic-bold';
import { type BoldLook, devicePxPerPt, inkSourceOf, PLAIN_LOOK, PLAN_PX_PER_PT } from './BoldCanvas';
import type { PagePaint } from './page-driver';
import type { PageLayerContext } from './PageView';

export interface ScanInkSource {
  /** The page's recognised text as the recogniser laid it out (not refined by these cuts), or null for a page PDFium reads. */
  rawGlyphs(pageIndex: number): Promise<PageGlyphs | null>;
}

/** One page's grown letters: for one picture (its key and size) and one weight, by the word's first char index. */
export interface GrownPage {
  key: string;
  words: Map<number, GrownLetter[]>;
  /** Counts each change of `words`. */
  version: number;
}

/**
 * Letters grown on one picture at one weight: `next`, the next word to grow (-1 once all were tried); `waiting`, words
 * whose line was not all on screen yet (tiles); the line being read.
 */
interface Grown extends GrownPage {
  look: string;
  next: number;
  waiting: number[];
  /** Words grown while only part of them was shown (tiles), with how much: grown again when more is. */
  cover: Map<number, number>;
  reading: { line: InkWord[]; tiles: string; src: ReturnType<typeof inkSourceOf> } | null;
}

interface PageState {
  ctx: PageLayerContext | null;
  /** The words of the page, from its recognised text; null before it is known, [] for a page PDFium reads. */
  words: InkWord[] | null;
  lines: InkWord[][];
  /** The plan, word by word as the lines are read, and from what picture (device px a point). */
  planned: Map<number, PlannedWord>;
  nextLine: number;
  plannedAt: number;
  /** Where each word's chars meet (page points along its text), by the word's first char index, once all lines are read. */
  cuts: Map<number, readonly number[]> | null;
  /** The grown letters made so far, by picture: the full render's, and the tiles' grid's. */
  grown: Map<string, Grown>;
  stopPaint: (() => void) | null;
  /** Words (indices into `words`) under the selection: grown first, as a mark on them may come next. */
  preferred: number[];
}

/** Below this many device px a point, a plan is redone when a sharper picture comes (the letters' edges are guesses). */
const SHARP_ENOUGH = 1.5;
/** Idle time left that is worth starting a line or a word in (ms)… */
const MIN_IDLE_MS = 3;
/** … and at most this much is waited for (an idle time is at most 50 ms). */
const MAX_WAIT_FOR_MS = 40;
/** A task growing the words of a selection just made lasts about this long. */
const URGENT_MS = 12;

const lookKey = (l: BoldLook) => `${l.gain}|${l.boost}`;
/** A picture's grid: the full render's size, or the whole page at the tiles' size. */
const pictureKey = (p: PagePaint) => `${p.rect ? 'tiles ' : ''}${Math.round(p.width / p.box.width)}x${Math.round(p.height / p.box.height)}|${p.viewRotation}`;

export class ScanInkPages {
  private readonly states = new Map<number, PageState>();
  private readonly refined = new Set<(pageIndex: number) => void>();
  private readonly aheadListeners = new Set<(pageIndex: number) => void>();
  private look: BoldLook = PLAIN_LOOK;
  private scheduled = false;
  /** The slowest step lately (ms), slowly forgotten: how much idle time a step needs to start. */
  private slowest = 20;
  private disposed = false;

  constructor(
    private readonly source: ScanInkSource,
    private readonly pages: readonly PageSize[],
  ) {}

  /** Reads page `pageIndex` ahead while it is on screen (its layer context `ctx`). Returns the function that stops. */
  watch(pageIndex: number, ctx: PageLayerContext): () => void {
    const s = this.stateOf(pageIndex);
    s.ctx = ctx;
    s.stopPaint?.();
    s.stopPaint = ctx.onPaint(() => this.schedule());
    if (s.words === null) void this.loadWords(pageIndex, s);
    this.schedule();
    return () => {
      if (s.ctx !== ctx) return;
      s.stopPaint?.();
      s.stopPaint = null;
      s.ctx = null;
      s.grown.clear(); // the grown letters are only kept for pages on screen
    };
  }

  /** The page's recognised text arrived or changed: it is read again. */
  pageTextChanged(pageIndex: number): void {
    const had = this.states.get(pageIndex);
    if (!had) return;
    const ctx = had.ctx;
    had.stopPaint?.();
    this.states.delete(pageIndex);
    if (had.cuts !== null) this.emit(pageIndex);
    if (ctx) this.watch(pageIndex, ctx);
  }

  /**
   * The chars selected now, by page: their words are read ahead first (a mark on them is likely next). `now`: the
   * selection is made (the pointer is up), so they are grown at once, a few at a time, without waiting for idle time.
   */
  prefer(ranges: readonly { pageIndex: number; start: number; end: number }[], now = false): void {
    for (const s of this.states.values()) s.preferred = [];
    for (const r of ranges) {
      const s = this.states.get(r.pageIndex);
      if (!s?.words) continue;
      s.words.forEach((w, k) => {
        if (w.start < r.end && w.start + w.chars.length > r.start) s.preferred.push(k);
      });
    }
    if (ranges.length === 0) return;
    this.schedule();
    if (now) this.soon();
  }

  /** Grows the preferred words in short tasks (URGENT_MS each) until they are done. */
  private soon(): void {
    setTimeout(() => {
      if (this.disposed) return;
      const until = performance.now() + URGENT_MS;
      if (this.work({ timeRemaining: () => until - performance.now() }, true)) this.soon();
    }, 0);
  }

  /** Where each word's chars meet on page `pageIndex` (see the file comment), or null while it is not read. */
  cuts(pageIndex: number): ReadonlyMap<number, readonly number[]> | null {
    return this.states.get(pageIndex)?.cuts ?? null;
  }

  /**
   * The page's plan of `words` (each by its first char), with their letters bold as each word's from and to say; null
   * unless every one is planned (or known to have no clear ink, then left out).
   */
  plannedWords(pageIndex: number, words: readonly InkWord[]): PlannedWord[] | null {
    const s = this.states.get(pageIndex);
    if (!s || s.cuts === null) return null;
    const out: PlannedWord[] = [];
    for (const w of words) {
      const pw = s.planned.get(w.start);
      if (pw) out.push(markedWord(pw, w.from, w.to));
      else if (!s.words?.some((x) => x.start === w.start)) return null;
    }
    return out;
  }

  /** Whether any of page `pageIndex`'s words are grown on `paint`'s grid (at the weight read ahead). */
  hasAhead(pageIndex: number, paint: PagePaint): boolean {
    const g = this.states.get(pageIndex)?.grown.get(pictureKey(paint));
    return g !== undefined && g.look === lookKey(this.look) && g.words.size > 0;
  }

  /** Calls `listener` when a page's words have all been grown, or tried, on one of its pictures. Returns the function that stops. */
  onAhead(listener: (pageIndex: number) => void): () => void {
    this.aheadListeners.add(listener);
    return () => this.aheadListeners.delete(listener);
  }

  /** Calls `listener` when a page's cuts arrive or go (its char boxes change). Returns the function that stops. */
  onRefined(listener: (pageIndex: number) => void): () => void {
    this.refined.add(listener);
    return () => this.refined.delete(listener);
  }

  /**
   * Page `pageIndex`'s grown letters for picture `paint` at weight `look`, or null while they are not made. Asking for
   * another weight makes that the one read ahead.
   */
  grown(pageIndex: number, paint: PagePaint, look: BoldLook): GrownPage | null {
    if (lookKey(look) !== lookKey(this.look)) {
      this.look = look;
      this.schedule();
    }
    const g = this.states.get(pageIndex)?.grown.get(pictureKey(paint));
    return g && g.look === lookKey(look) ? g : null;
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.states.values()) s.stopPaint?.();
    this.states.clear();
    this.refined.clear();
    this.aheadListeners.clear();
  }

  private stateOf(pageIndex: number): PageState {
    let s = this.states.get(pageIndex);
    if (!s) this.states.set(pageIndex, (s = { ctx: null, words: null, lines: [], planned: new Map(), nextLine: 0, plannedAt: 0, cuts: null, grown: new Map(), stopPaint: null, preferred: [] }));
    return s;
  }

  private async loadWords(pageIndex: number, s: PageState): Promise<void> {
    const g = await this.source.rawGlyphs(pageIndex).catch(() => null);
    if (this.states.get(pageIndex) !== s || s.words !== null) return;
    s.words = g === null ? [] : inkWordsOf(g.glyphs, [{ start: 0, end: g.glyphs.length }]).map((w) => ({ ...w, from: 0, to: w.chars.length }));
    s.lines = linesOf(s.words);
    this.schedule();
  }

  private emit(pageIndex: number): void {
    for (const l of [...this.refined]) l(pageIndex);
  }

  private schedule(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    const idle = (f: (d: { timeRemaining(): number }) => void) =>
      typeof requestIdleCallback === 'function' ? requestIdleCallback(f, { timeout: 4000 }) : setTimeout(() => f({ timeRemaining: () => 8 }), 30);
    idle((deadline) => {
      this.scheduled = false;
      if (this.disposed) return;
      if (this.work(deadline)) this.schedule();
    });
  }

  /** Does what fits in this idle time; whether there is more to do. */
  private work(deadline: { timeRemaining(): number }, preferredOnly = false): boolean {
    let more = false;
    for (const [pageIndex, s] of this.states) {
      if (!s.ctx || s.words === null || s.words.length === 0) continue;
      if (preferredOnly && (s.cuts === null || !this.preferredLeft(this.pages[pageIndex], s, s.ctx.paints()))) continue;
      const paints = s.ctx.paints();
      const full = paints.find((p) => p.rect === undefined);
      if (!full) continue;
      const page = this.pages[pageIndex];
      if (!page) continue;
      // A step starts only when the idle time left can hold the slowest one lately: while the page scrolls, idle times
      // are short and the work waits for it to stop.
      const need = () => (preferredOnly ? MIN_IDLE_MS : Math.max(MIN_IDLE_MS, Math.min(MAX_WAIT_FOR_MS, this.slowest)));
      while (deadline.timeRemaining() > need()) {
        const t0 = performance.now();
        const step = this.step(pageIndex, s, page, full, paints, preferredOnly);
        const dt = performance.now() - t0;
        this.slowest = Math.max(dt, this.slowest * 0.9);
        if (step === 'done') break;
      }
      if (preferredOnly ? this.preferredLeft(page, s, paints) : this.pending(page, s, paints)) more = true;
      if (deadline.timeRemaining() <= need()) return more || true;
    }
    return more;
  }

  private pending(page: PageSize, s: PageState, paints: readonly PagePaint[]): boolean {
    if (s.cuts === null || s.nextLine < s.lines.length) return true;
    return pictures(paints).some((p) => {
      const g = s.grown.get(pictureKey(p));
      return !g || g.look !== lookKey(this.look) || g.next >= 0 || g.waiting.some((w) => this.covered(page, s, p, paints, w)) || [...g.cover].some(([w, c]) => this.coverage(page, s, p, paints, w) > c + 0.01);
    });
  }

  /** Whether a selected word is still to grow on a picture shown (where some of it is shown). */
  private preferredLeft(page: PageSize, s: PageState, paints: readonly PagePaint[]): boolean {
    const words = s.words ?? [];
    return pictures(paints).some((p) => {
      const g = s.grown.get(pictureKey(p));
      return s.preferred.some((k) => !g?.words.has(words[k].start) && s.planned.has(words[k].start) && this.covered(page, s, p, paints, k));
    });
  }

  /** Whether every tile under word `w`'s line is shown (for the full render: always). */
  private covered(page: PageSize, s: PageState, p: PagePaint, paints: readonly PagePaint[], w: number): boolean {
    return this.coverage(page, s, p, paints, w) > 0;
  }

  /**
   * How much of word `w`'s box the tiles shown cover, 0 to 1 (the full render: 1). A word is grown as soon as some of
   * it is shown (a page wider than the window never shows all of a line), and again when more of it is.
   */
  private coverage(page: PageSize, s: PageState, p: PagePaint, paints: readonly PagePaint[], w: number): number {
    if (p.rect === undefined) return 1;
    const word = s.words![w];
    const gw = Math.round(p.width / p.box.width);
    const gh = Math.round(p.height / p.box.height);
    const d = pageToDevice(page, p.viewRotation, gw, gh);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const c of word.chars)
      for (const [px, py] of [
        [c.x, c.y],
        [c.x + c.width, c.y + c.height],
      ] as const) {
        const X = d[0] * px + d[2] * py + d[4];
        const Y = d[1] * px + d[3] * py + d[5];
        x0 = Math.min(x0, X);
        x1 = Math.max(x1, X);
        y0 = Math.min(y0, Y);
        y1 = Math.max(y1, Y);
      }
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(gw, x1);
    y1 = Math.min(gh, y1);
    const all = (x1 - x0) * (y1 - y0);
    if (all <= 0) return 0;
    let area = 0;
    for (const t of paints) {
      if (t.rect === undefined || Math.round(t.width / t.box.width) !== gw) continue;
      const tx = Math.round(t.box.left * gw);
      const ty = Math.round(t.box.top * gh);
      area += Math.max(0, Math.min(x1, tx + t.width) - Math.max(x0, tx)) * Math.max(0, Math.min(y1, ty + t.height) - Math.max(y0, ty));
    }
    return Math.min(1, area / all);
  }


  /** One line of the plan, or one word grown. */
  private step(pageIndex: number, s: PageState, page: PageSize, full: PagePaint, paints: readonly PagePaint[], preferredOnly = false): 'did' | 'done' {
    const pxPerPt = devicePxPerPt({ paints: () => [full] }, page)!;
    // The plan: again from a sharper picture if it was read from a blurry one.
    if (s.cuts !== null && s.plannedAt < SHARP_ENOUGH && pxPerPt > s.plannedAt * 1.2) {
      s.planned.clear();
      s.nextLine = 0;
      s.cuts = null;
      s.grown.clear();
    }
    if (s.nextLine < s.lines.length) {
      const scale = Math.min(1, PLAN_PX_PER_PT / pxPerPt);
      const line = s.lines[s.nextLine++];
      const { src, device } = inkSourceOf(page, full, paints, line, scale);
      for (const pw of planInk(src, device, line).words) s.planned.set(pw.word.start, pw);
      s.plannedAt = pxPerPt * scale;
      if (s.nextLine === s.lines.length) {
        const cuts = new Map<number, readonly number[]>();
        for (const pw of s.planned.values()) {
          const c = letterCuts(pw);
          if (c) cuts.set(pw.word.start, c);
        }
        s.cuts = cuts;
        this.emit(pageIndex);
      }
      return 'did';
    }
    // The grown letters, at this weight: on the full render, then on the tiles' grid (a line once its tiles are shown).
    const look = lookKey(this.look);
    const shown = pictures(paints);
    for (const key of s.grown.keys()) if (!shown.some((p) => pictureKey(p) === key)) s.grown.delete(key);
    for (const p of shown) {
      const key = pictureKey(p);
      let g = s.grown.get(key);
      if (!g || g.look !== look) s.grown.set(key, (g = { key, look, words: new Map(), version: 0, next: 0, waiting: [], cover: new Map(), reading: null }));
      const words = s.words!;
      let w: number;
      const first = s.preferred.find((k) => !g.words.has(words[k].start) && s.planned.has(words[k].start) && this.covered(page, s, p, paints, k));
      if (first !== undefined) w = first;
      else if (preferredOnly) continue;
      else if (g.next >= 0 && g.next < words.length) w = g.next++;
      else {
        if (g.next >= words.length) {
          g.next = -1;
          g.reading = null;
          for (const l of [...this.aheadListeners]) l(pageIndex);
        }
        const k = g.waiting.findIndex((x) => this.covered(page, s, p, paints, x));
        const more = k >= 0 ? -1 : [...g.cover].find(([x, c]) => this.coverage(page, s, p, paints, x) > c + 0.01)?.[0];
        if (k >= 0) w = g.waiting.splice(k, 1)[0]!;
        else if (more !== undefined && more >= 0) {
          w = more;
          g.words.delete(words[w].start);
          g.version++;
        } else continue;
      }
      const word = words[w];
      if (g.words.has(word.start)) return 'did';
      const pw = s.planned.get(word.start);
      if (!pw) {
        g.words.set(word.start, []); // no clear ink: a mark draws nothing there
        g.version++;
        return 'did';
      }
      if (!this.covered(page, s, p, paints, w)) {
        g.waiting.push(w);
        return 'did';
      }
      // The line's px are read once for all its words (again when the tiles shown change).
      const tiles = p.rect === undefined ? '' : paints.filter((t) => t.rect !== undefined).map((t) => t.key).join(',');
      if (!g.reading?.line.includes(word) || g.reading.tiles !== tiles) {
        const line = s.lines.find((l) => l.includes(word)) ?? [word];
        g.reading = { line, tiles, src: inkSourceOf(page, p, paints, line) };
      }
      const { src, device } = g.reading.src;
      const letters = growLetters(src, device, pw, this.look, Math.round(p.width / p.box.width));
      if (letters) {
        g.words.set(word.start, letters);
        g.version++;
      }
      const c = this.coverage(page, s, p, paints, w);
      if (c < 1) g.cover.set(w, c);
      else g.cover.delete(w);
      return 'did';
    }
    return 'done';
  }
}

/** The pictures worth reading ahead on: the full render (or base), and one tile for the tiles' grid. */
function pictures(paints: readonly PagePaint[]): PagePaint[] {
  const full = paints.find((p) => p.rect === undefined);
  const tile = paints.find((p) => p.rect !== undefined);
  return [...(full ? [full] : []), ...(tile ? [tile] : [])];
}

/** Reads page `index` ahead while it is mounted (a page layer with nothing to show). */
export function ScanInkWatch({ pages, index, ctx }: { pages: ScanInkPages; index: number; ctx: PageLayerContext }): null {
  useEffect(() => pages.watch(index, ctx), [pages, index, ctx]);
  return null;
}
