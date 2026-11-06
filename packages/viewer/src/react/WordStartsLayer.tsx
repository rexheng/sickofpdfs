// Bold word starts (rulings R90, R90b, R90c): the first part of every word drawn bold over the page, to guide the eye.
// A reading aid, not a mark: it is not saved, never prints (print draws pages from PDFium, not from this layer) and
// never changes the file. The word rule is marks/word-starts.ts; the bold is synthetic bold (marks/synthetic-bold.ts,
// marks/bold-painter.ts): each glyph's own outline pushed outward along its edges by its face's own regular-to-bold
// gain, never closing the gap to its neighbours or a counter, filled in its colour on exactly the page picture's pixel
// grid (BoldCanvas, in the page's underlay, under the marks and the selection). "How bold" sets its look (setLook).
// Maths glyphs, and a word of one italic letter in upright text, are left alone (R90c).
//
// - It takes no pointer, so selecting, copying, Find, links, marks and comments work exactly as without it. The owner's
//   own bold marks are drawn the same way, whole words.
// - A page's glyphs are kept in page points, so zoom, rotation, two-page view and presentation mode only redraw them,
//   in the same frame as the page's picture. A few paths a page (one per colour), never a node per glyph.
// - The work for a page (its chars, then its glyphs: a page in view in one or two engine calls, others a few hundred
//   chars a call) starts after the page's own render is on screen, and only while the reader is not scrolling. A page
//   in view goes then; the others also wait until the engine is not drawing pages (RenderScheduler.isIdle). Visible
//   pages go first, then the pages mounted around them, then, at idle, the next pages either side, so scrolling on
//   finds them ready. The last PAGES_KEPT pages are kept, and a page met again is drawn in the same frame as its
//   picture; bold that comes after its page's picture (a page jumped to for the first time) fades in.
// - A page with no outline to draw (a scan, whose OCR text is invisible; a page with no text) is left as it is, and the
//   controller says so (onNothingToDraw) when such a page is in view, for R90's quiet note.
import { memo, useLayoutEffect, useRef, useSyncExternalStore, type JSX } from 'react';
import { PdfEngineCrashedError } from '../backend/errors';
import type { DocHandle, GlyphPlacement, PageSize, PdfBackend } from '../backend/types';
import type { PageBox } from '../layout/page-layout';
import { type BoldGlyph, boldGlyphs, type BoldRange, prepareGlyphs } from '../marks/bold-painter';
import { type WordStartChunk, wordStartChunks, wordStartRanges } from '../marks/word-starts';
import { type BoldLook, devicePxPerPt, PLAIN_LOOK, useBoldCanvas } from './BoldCanvas';
import type { PageLayerContext } from './PageView';

/** Chars read either side of an engine call's word starts, for the end glyphs' neighbours. */
const NEIGHBOUR_CHARS = 2;
/** Chars of a page per getGlyphShapes call: a few ms of the engine worker on a paper's page. */
const CHARS_PER_CALL = 512;
/**
 * Chars per call for a page in view (or not yet known to be out of view, as when the switch has just been turned on):
 * the reader is waiting for it, and each call is a round trip through a busy main thread, so it takes a whole page of
 * a paper in one call (some 30 ms of the worker; the first call on a page, which also reads its faces, up to 100).
 */
const VISIBLE_CHARS_PER_CALL = 4096;
/** The work waits until the page list has not scrolled for this long. */
const SCROLL_IDLE_MS = 120;
/** While the pages are being drawn, the work looks again this often. */
const BUSY_RECHECK_MS = 50;
/** Pages kept besides the mounted ones (their glyphs in points: a few hundred kB a page). */
const PAGES_KEPT = 24;
/** Bold that comes within this long of turning the switch on is its answer, shown at once; later it fades in. */
const TURN_ON_MS = 1000;
/** At idle, the pages this far after (and one before) each visible page are made ready too. */
const PREFETCH_AHEAD = 2;
/** The perf mark made when a page's word starts are on screen. */
export const WORD_STARTS_PERF_MARK = 'sop:word-starts-drawn';

/** What a page shows: its glyphs to embolden (none for a scan or a page without text), and whether it has words. */
export interface WordStartsPage {
  glyphs: BoldGlyph[];
  hasText: boolean;
}

export interface WordStartsControllerOptions {
  backend: Pick<PdfBackend, 'getGlyphShapes'>;
  doc: DocHandle;
  /** The page's chars, one UTF-16 unit each (the page text provider's rawText: getPageChars, cached per page). */
  text: { rawText(pageIndex: number): Promise<string> };
  pageCount: number;
  /**
   * Whether the engine is free of page drawing (RenderScheduler.isIdle). Engine calls wait for it, so a jump or a zoom
   * never waits behind word starts, except a page in view whose own picture is drawn: it goes once the scrolling stops,
   * so its bold follows it closely instead of waiting for the pages around it. Without it, only the scrolling is waited for.
   */
  renderIdle?: () => boolean;
  /**
   * A page in view with the switch on has nothing to draw: no words (`hasText` false), or words with no outline (a
   * scan's invisible OCR text, Type3 fonts). Called each time such a page comes into view while the switch is on.
   */
  onNothingToDraw?: (pageIndex: number, hasText: boolean) => void;
}

/** A page being worked on: its word starts, in engine calls, and the glyphs kept so far. */
interface Work {
  ranges: BoldRange[];
  /** The page's char count. */
  chars: number;
  /** Where each word of one letter starts (wordStartRanges). */
  singles: Set<number>;
  chunks: WordStartChunk[];
  next: number;
  kept: BoldGlyph[];
}

/** A mounted page. */
interface Slot {
  index: number;
  el: Element | null;
  visible: boolean;
  /** The IntersectionObserver has told whether its marker is in view (until then it may be, as when the switch has just been turned on). */
  known: boolean;
  /** Its own render is on screen (PageLayerContext.whenPainted): its work may start. */
  painted: boolean;
  ctx: PageLayerContext;
  /** The page's unrotated size, when the layer gave it: the bold is prepared at its pictures' scale. */
  page: PageSize | undefined;
}

/** While the switch is on and a page's glyphs are still being read: nothing drawn yet. */
const PENDING: WordStartsPage = { glyphs: [], hasText: true };

/** Whether the glyphs either side of glyph `i` (those there are) are italic too: the letter is in italic text. */
function italicAround(all: readonly GlyphPlacement[], i: number): boolean {
  const before = all[i - 1];
  const after = all[i + 1];
  return (before === undefined || before.italic === true) && (after === undefined || after.italic === true);
}

/** A keep(charIndex) for glyphs met in char order: true inside one of `ranges` (sorted, not overlapping). */
function inRanges(ranges: readonly BoldRange[]): (charIndex: number) => boolean {
  let r = 0;
  return (i) => {
    while (r < ranges.length && ranges[r].end <= i) r++;
    const range = ranges[r];
    return range !== undefined && i >= range.start;
  };
}

/**
 * The open document's bold word starts: the switch, the work queue and each page's glyphs. One per document, made by
 * the viewer with the page text provider; WordStartsLayer draws a page from it.
 */
export class WordStartsController {
  private on = false;
  /** When the switch was last turned on (performance.now()). */
  private onAt = -Infinity;
  private heavy: BoldLook = PLAIN_LOOK;
  private disposed = false;
  private running = false;
  private readonly slots = new Map<number, Slot>();
  private readonly cache = new Map<number, WordStartsPage>();
  private readonly work = new Map<number, Work>();
  private readonly failed = new Set<number>();
  private readonly listeners = new Set<() => void>();
  private observer: IntersectionObserver | null = null;
  private lastScrollAt = -Infinity;
  private readonly onScroll = () => (this.lastScrollAt = performance.now());
  private crashed = false;

  constructor(private readonly o: WordStartsControllerOptions) {}

  get enabled(): boolean {
    return this.on;
  }

  /**
   * Whether a page's bold coming now comes to a page the reader moved to (scrolled or jumped), not in answer to the
   * switch: it fades in, so there is no plain-then-bold flash. Turning the switch on shows the bold at once.
   */
  get arrivesLate(): boolean {
    return performance.now() - this.onAt > TURN_ON_MS;
  }

  /** How heavy the bold is ("How bold": the gain on each face's own bold, and the edge darkening). */
  get look(): BoldLook {
    return this.heavy;
  }

  /** Sets "How bold": every page redraws with it at once. */
  setLook(look: BoldLook): void {
    if ((look.gain === this.heavy.gain && look.boost === this.heavy.boost) || !(look.gain > 0)) return;
    this.heavy = { gain: look.gain, boost: look.boost };
    this.emit();
  }

  /** Turns the word starts on or off for every page of this document. Glyphs already read are kept, so on is instant. */
  setEnabled(on: boolean): void {
    if (on === this.on || this.disposed) return;
    this.on = on;
    if (on) this.onAt = performance.now();
    this.emit();
    if (!on) return;
    for (const s of this.slots.values()) this.tellIfEmpty(s);
    void this.pump();
  }

  subscribe = (onChange: () => void): (() => void) => {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  };

  /** What page `pageIndex` shows: null while the switch is off; its glyphs once read (none until then). */
  page = (pageIndex: number): WordStartsPage | null => {
    if (!this.on) return null;
    return this.cache.get(pageIndex) ?? PENDING;
  };

  /** A page was mounted (its layer context). Returns the function that unmounts it. */
  attach(pageIndex: number, ctx: PageLayerContext, page?: PageSize): () => void {
    const slot: Slot = { index: pageIndex, el: null, visible: false, known: false, painted: false, ctx, page };
    this.slots.set(pageIndex, slot);
    this.failed.delete(pageIndex);
    ctx.whenPainted().then(
      () => {
        slot.painted = true;
        void this.pump();
      },
      () => {},
    );
    return () => {
      if (slot.el) this.observer?.unobserve(slot.el);
      if (this.slots.get(pageIndex) === slot) this.slots.delete(pageIndex);
    };
  }

  /** The page's marker is in the DOM (the switch is on): it is watched for coming into view. Returns the function that stops. */
  observe(pageIndex: number, el: Element): () => void {
    const slot = this.slots.get(pageIndex);
    if (!slot || typeof IntersectionObserver === 'undefined') return () => {};
    this.observer ??= new IntersectionObserver((entries) => this.onIntersect(entries));
    slot.el = el;
    slot.known = false;
    this.observer.observe(el);
    return () => {
      this.observer?.unobserve(el);
      if (slot.el === el) {
        slot.el = null;
        slot.visible = false;
        slot.known = false;
      }
    };
  }

  /** Starts listening to the page list's scrolling (the work waits for it to stop). The viewer calls it once mounted. */
  start(): void {
    this.disposed = false;
    if (typeof document !== 'undefined') document.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    void this.pump();
  }

  /** Stops all work. start() undoes it (React's StrictMode unmounts and mounts every component once in development). */
  dispose(): void {
    this.disposed = true;
    this.observer?.disconnect();
    this.observer = null;
    if (typeof document !== 'undefined') document.removeEventListener('scroll', this.onScroll, { capture: true });
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    let more = false;
    for (const e of entries) {
      const slot = [...this.slots.values()].find((s) => s.el === e.target);
      if (!slot) continue;
      const was = slot.visible;
      slot.visible = e.isIntersecting;
      slot.known = true;
      if (slot.visible && !was) {
        this.tellIfEmpty(slot);
        more = true;
      }
    }
    if (more) void this.pump();
  }

  /** R90's note: a page in view, switch on, with nothing to draw. */
  private tellIfEmpty(s: Slot): void {
    const drawn = this.cache.get(s.index);
    if (this.on && s.visible && drawn !== undefined && drawn.glyphs.length === 0) this.o.onNothingToDraw?.(s.index, drawn.hasText);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  /** The pages worth reading now, best first: in view, then mounted, then (prefetch) near those in view. */
  private wanted(): number[] {
    const out: number[] = [];
    const add = (i: number) => {
      if (i >= 0 && i < this.o.pageCount && !this.cache.has(i) && !this.failed.has(i) && !out.includes(i)) out.push(i);
    };
    const slots = [...this.slots.values()].sort((a, b) => a.index - b.index);
    for (const s of slots) if (s.visible && s.painted) add(s.index);
    for (const s of slots) if (s.painted) add(s.index);
    for (const s of slots) {
      if (!s.visible) continue;
      for (let d = 1; d <= PREFETCH_AHEAD; d++) add(s.index + d);
      add(s.index - 1);
    }
    return out;
  }

  /** Works through the pages, one engine call at a time, while the switch is on. */
  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        if (!this.on || this.disposed || this.crashed) return;
        // A page in view whose own picture is drawn goes as soon as the scrolling stops, before the renders of pages out
        // of view (R90c: the bold follows its page, not the whole queue). The rest wait for the engine to be free.
        await this.engineFree(() => this.urgent(this.wanted()[0]));
        if (!this.on || this.disposed) return;
        const wanted = this.wanted();
        const index = wanted[0];
        if (index === undefined) return;
        // Work for pages no longer wanted is dropped.
        for (const i of this.work.keys()) if (!wanted.includes(i)) this.work.delete(i);
        try {
          await this.step(index);
        } catch (err) {
          this.failed.add(index);
          this.work.delete(index);
          if (err instanceof PdfEngineCrashedError) {
            this.crashed = true; // the viewer opens the document again, with a new controller
            return;
          }
          console.error(`sickofpdfs: bold word starts could not be drawn on page ${index + 1}`, err);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** One engine call for page `index`: its chars first, then its glyphs a chunk at a time; the last one shows the page. */
  private async step(index: number): Promise<void> {
    let w = this.work.get(index);
    if (!w) {
      const chars = await this.o.text.rawText(index);
      if (this.disposed) return;
      const singles = new Set<number>();
      const ranges = wordStartRanges(chars, singles);
      this.work.set(index, (w = { ranges, chars: chars.length, singles, chunks: wordStartChunks(ranges, CHARS_PER_CALL), next: 0, kept: [] }));
    }
    const first = w.chunks[w.next];
    if (first !== undefined) {
      // The next chunks, up to the call's size, in one call.
      const slot = this.slots.get(index);
      const limit = slot !== undefined && (slot.visible || !slot.known) ? VISIBLE_CHARS_PER_CALL : CHARS_PER_CALL;
      let last = w.next;
      while (last + 1 < w.chunks.length && w.chunks[last + 1].end - first.start <= limit) last++;
      const chunk = { start: first.start, end: w.chunks[last].end, ranges: w.chunks.slice(w.next, last + 1).flatMap((c) => c.ranges) };
      // A char or two either side too, so the glyphs at the ends know their neighbours (R90c: no gap is closed).
      const from = Math.max(0, chunk.start - NEIGHBOUR_CHARS);
      const set = await this.o.backend.getGlyphShapes(this.o.doc, index, from, Math.min(w.chars, chunk.end + NEIGHBOUR_CHARS) - from);
      if (this.disposed || this.work.get(index) !== w) return;
      const inside = inRanges(chunk.ranges);
      const singles = w.singles;
      // R90c: maths glyphs, and a word of one italic letter in upright text (a maths letter in a text font), stay as they are.
      const glyphs = boldGlyphs(set, (g, i, all) => inside(g.charIndex) && g.maths !== true && !(g.italic === true && singles.has(g.charIndex) && !italicAround(all, i)));
      // Their emboldened outlines are worked out now, a chunk at a time, at the page's scale, so drawing the page is only placing them.
      await prepareGlyphs(glyphs, this.heavy.gain, slot?.page ? devicePxPerPt(slot.ctx, slot.page) : undefined);
      if (this.disposed || this.work.get(index) !== w) return;
      for (const g of glyphs) w.kept.push(g);
      w.next = last + 1;
    }
    if (w.next < w.chunks.length) return;
    this.work.delete(index);
    this.remember(index, { glyphs: w.kept, hasText: w.ranges.length > 0 });
    this.emit();
    const slot = this.slots.get(index);
    if (slot) this.tellIfEmpty(slot);
  }

  /** Keeps a page's glyphs; beyond PAGES_KEPT, the oldest page not mounted goes. */
  private remember(index: number, page: WordStartsPage): void {
    this.cache.delete(index);
    this.cache.set(index, page);
    for (const i of this.cache.keys()) {
      if (this.cache.size <= PAGES_KEPT + this.slots.size) break;
      if (!this.slots.has(i)) this.cache.delete(i);
    }
  }

  /** Whether page `index` is in view (or may be) with its own picture drawn: its work need not wait for other renders. */
  private urgent(index: number | undefined): boolean {
    const slot = index === undefined ? undefined : this.slots.get(index);
    return slot !== undefined && slot.painted && (slot.visible || !slot.known);
  }

  /**
   * Waits until the page list has not scrolled for SCROLL_IDLE_MS and, unless the page to work on next is `urgent` (asked
   * again at each look, as pages come into view), the engine is not drawing pages (renderIdle).
   */
  private async engineFree(urgent: () => boolean = () => false): Promise<void> {
    for (;;) {
      const wait = this.lastScrollAt + SCROLL_IDLE_MS - performance.now();
      if (wait <= 0 && (urgent() || (this.o.renderIdle?.() ?? true))) return;
      await new Promise((resolve) => setTimeout(resolve, Math.max(wait, BUSY_RECHECK_MS)));
      if (this.disposed) return;
    }
  }
}

export interface WordStartsLayerProps {
  controller: WordStartsController;
  box: PageBox;
  ctx: PageLayerContext;
  /** The page's unrotated size and /Rotate (OpenResult.pages[box.index]). */
  page: PageSize;
}

/**
 * One page's bold word starts: synthetic bold in the page's underlay, and an empty marker in its layers that says the
 * switch is on (`.sop-word-starts`, `data-drawn` once the page's glyphs are drawn). Nothing while the switch is off.
 */
export const WordStartsLayer = memo(function WordStartsLayer({ controller, box, ctx, page }: WordStartsLayerProps): JSX.Element | null {
  const index = box.index;
  const marker = useRef<HTMLDivElement>(null);
  const shown = useSyncExternalStore(controller.subscribe, () => controller.page(index));
  const look = useSyncExternalStore(controller.subscribe, () => controller.look);
  const on = shown !== null;
  useLayoutEffect(() => controller.attach(index, ctx, page), [controller, index, ctx, page]);
  useLayoutEffect(() => (on && marker.current ? controller.observe(index, marker.current) : undefined), [controller, index, ctx, on]);
  useBoldCanvas(ctx, page, shown?.glyphs ?? null, 'sop-word-starts-canvas', (n) => {
    marker.current?.toggleAttribute('data-drawn', n > 0);
    if (n > 0) performance.mark(WORD_STARTS_PERF_MARK, { detail: { pageIndex: index } });
  }, look, controller.arrivesLate);
  if (!on) return null;
  return <div ref={marker} className="sop-word-starts" data-sop-word-starts-page={index} aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />;
});
