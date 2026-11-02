// Bold word starts (ruling R90): the first part of every word drawn bold over the page, to guide the eye. A reading aid,
// not a mark: it is not saved, never prints (print draws pages from PDFium, not from this layer) and never changes the
// file. The word rule is marks/word-starts.ts; the drawing is BoldLayer's glyph-outline overlay with a heavier stroke.
//
// - One <svg> per page, the first of the page's layers, so it lies under the marks, the selection and the text layer
//   and takes no pointer: selecting, copying, Find, links, marks and comments work exactly as without it. The owner's
//   own bold marks are drawn above it, whole words (MarkLayer's boldStrokeScale gives them the same weight).
// - Its user units are points of the unrotated page, turned by the page's /Rotate plus the view's rotation (the one
//   page turn), so it turns with the page and fits any zoom. The paths are made once per page: zooming, rotating,
//   two-page view and presentation mode only redraw them. A few paths a page (one per colour and stroke width), never a
//   node per glyph.
// - The work for a page (its chars, then its outlines a few hundred chars per engine call) starts only after the
//   page's own render is on screen, and only while the reader is not scrolling and the engine is not drawing pages.
//   Visible pages go first, then the pages mounted around them. The engine worker also draws the pages, so each call is
//   kept short, one call is out at a time, and each waits until no page render is queued (RenderScheduler.isIdle). A
//   page's paths are kept while the page is mounted, and dropped with it.
// - A page with no outline to draw (a scan, whose OCR text is invisible; a page with no text) is left as it is, and the
//   controller says so (onNothingToDraw) when such a page is in view, for R90's quiet note.
import { memo, useLayoutEffect, useRef, useSyncExternalStore, type JSX } from 'react';
import { PdfEngineCrashedError } from '../backend/errors';
import type { DocHandle, GlyphOutline, PageSize, PdfBackend, Rotation } from '../backend/types';
import type { PageBox } from '../layout/page-layout';
import { type BoldRange, displayTransform, type DrawnRange, glyphPaths } from '../marks/BoldLayer';
import { type WordStartChunk, wordStartChunks, wordStartRanges } from '../marks/word-starts';
import type { PageLayerContext } from './PageView';

/**
 * The word starts' stroke, in ems of the glyph's font size: a glyph's own outline, filled and stroked this wide, reads
 * as clearly bold at 100% (R90; a bold mark's is BOLD_STROKE_EM, 0.03).
 */
export const WORD_STARTS_STROKE_EM = 0.07;
/**
 * Text that is already bold (its font's weight, as PDFium reads it, is BOLD_FONT_WEIGHT or more: titles, headings,
 * author names) is stroked only this much, so its word starts still show without smudging into blots.
 */
export const WORD_STARTS_ON_BOLD_STROKE_EM = 0.03;
/** PDFium's weight for regular faces reads up to about 540 (stem widths), bold ones 570 and up (CMBX10, Times Bold 700). */
const BOLD_FONT_WEIGHT = 560;
/** Stroke widths are rounded to this many points, so a page in many sizes is still a few paths (0.03 px at 100%). */
const STROKE_QUANTUM_PT = 0.05;
/** Chars of a page per getGlyphOutlines call: about 2 to 5 ms of the engine worker on a paper's page. */
const CHARS_PER_CALL = 512;
/** The work waits until the page list has not scrolled for this long. */
const SCROLL_IDLE_MS = 120;
/** While the pages are being drawn, the work looks again this often. */
const BUSY_RECHECK_MS = 50;
/** The perf mark made when a page's word starts are on screen. */
export const WORD_STARTS_PERF_MARK = 'sop:word-starts-drawn';

/** What a page shows: its glyph paths (none for a scan or a page without text), and whether it has words at all. */
export interface WordStartsPage {
  glyphs: DrawnRange['glyphs'];
  hasText: boolean;
}

export interface WordStartsControllerOptions {
  backend: Pick<PdfBackend, 'getGlyphOutlines'>;
  doc: DocHandle;
  /** The page's chars, one UTF-16 unit each (the page text provider's rawText: getPageChars, cached per page). */
  text: { rawText(pageIndex: number): Promise<string> };
  /**
   * Whether the engine is free of page drawing (RenderScheduler.isIdle). Every engine call waits for it, so a jump or a
   * zoom never waits behind word starts. Without it, only the scrolling is waited for.
   */
  renderIdle?: () => boolean;
  /**
   * A page in view with the switch on has nothing to draw: no words (`hasText` false), or words with no outline (a
   * scan's invisible OCR text, Type3 fonts). Called each time such a page comes into view while the switch is on.
   */
  onNothingToDraw?: (pageIndex: number, hasText: boolean) => void;
}

/** A page being worked on: its word starts, in engine calls, and the outlines kept so far. */
interface Work {
  ranges: BoldRange[];
  chunks: WordStartChunk[];
  next: number;
  kept: GlyphOutline[];
}

/** A mounted page. */
interface Slot {
  index: number;
  el: Element | null;
  visible: boolean;
  /** Its own render is on screen (PageLayerContext.whenPainted): its work may start. */
  painted: boolean;
  work: Work | null;
  drawn: WordStartsPage | null;
  /** The engine could not give its chars or outlines: left undrawn until the page is mounted again. */
  failed: boolean;
}

/** While the switch is on and a page's paths are still being made: an empty svg, so the page can be watched. */
const PENDING: WordStartsPage = { glyphs: [], hasText: true };

/**
 * The open document's bold word starts: the switch, the work queue and each mounted page's paths. One per document,
 * made by the viewer with the page text provider; WordStartsLayer draws a page from it.
 */
export class WordStartsController {
  private on = false;
  private disposed = false;
  private running = false;
  private readonly slots = new Map<number, Slot>();
  private readonly listeners = new Set<() => void>();
  private observer: IntersectionObserver | null = null;
  private lastScrollAt = -Infinity;
  private readonly onScroll = () => (this.lastScrollAt = performance.now());
  private crashed = false;

  constructor(private readonly o: WordStartsControllerOptions) {}

  get enabled(): boolean {
    return this.on;
  }

  /** Turns the word starts on or off for every page of this document. Paths already made are kept, so on is instant. */
  setEnabled(on: boolean): void {
    if (on === this.on || this.disposed) return;
    this.on = on;
    this.emit();
    if (!on) return;
    for (const s of this.slots.values()) this.tellIfEmpty(s);
    void this.pump();
  }

  subscribe = (onChange: () => void): (() => void) => {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  };

  /** What page `pageIndex` shows: null while the switch is off; its paths once made (an empty set until then). */
  page = (pageIndex: number): WordStartsPage | null => {
    if (!this.on) return null;
    return this.slots.get(pageIndex)?.drawn ?? PENDING;
  };

  /** A page was mounted (its layer context). Returns the function that unmounts it, which drops its paths. */
  attach(pageIndex: number, ctx: PageLayerContext): () => void {
    const slot: Slot = { index: pageIndex, el: null, visible: false, painted: false, work: null, drawn: null, failed: false };
    this.slots.set(pageIndex, slot);
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

  /** The page's svg is in the DOM (the switch is on): it is watched for coming into view. Returns the function that stops. */
  observe(pageIndex: number, el: Element): () => void {
    const slot = this.slots.get(pageIndex);
    if (!slot || typeof IntersectionObserver === 'undefined') return () => {};
    this.observer ??= new IntersectionObserver((entries) => this.onIntersect(entries));
    slot.el = el;
    this.observer.observe(el);
    return () => {
      this.observer?.unobserve(el);
      if (slot.el === el) {
        slot.el = null;
        slot.visible = false;
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
      if (slot.visible && !was) {
        this.tellIfEmpty(slot);
        more = true;
      }
    }
    if (more) void this.pump();
  }

  /** R90's note: a page in view, switch on, with nothing to draw. */
  private tellIfEmpty(s: Slot): void {
    if (this.on && s.visible && s.drawn !== null && s.drawn.glyphs.length === 0) this.o.onNothingToDraw?.(s.index, s.drawn.hasText);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  /** The page to work on next: a page in view before one mounted around the view, then the first in page order. */
  private next(): Slot | null {
    let best: Slot | null = null;
    for (const s of this.slots.values()) {
      if (s.drawn !== null || s.failed || !s.painted) continue;
      if (best === null || (s.visible && !best.visible) || (s.visible === best.visible && s.index < best.index)) best = s;
    }
    return best;
  }

  /** Works through the pages, one engine call at a time, while the switch is on. */
  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        if (!this.on || this.disposed || this.crashed) return;
        await this.engineFree();
        if (!this.on || this.disposed) return;
        const slot = this.next();
        if (slot === null) return;
        try {
          await this.step(slot);
        } catch (err) {
          slot.failed = true;
          slot.work = null;
          if (err instanceof PdfEngineCrashedError) {
            this.crashed = true; // the viewer opens the document again, with a new controller
            return;
          }
          console.error(`sickofpdfs: bold word starts could not be drawn on page ${slot.index + 1}`, err);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** One engine call for `slot`: its chars first, then its outlines a chunk at a time; the last one draws the page. */
  private async step(slot: Slot): Promise<void> {
    const live = () => this.slots.get(slot.index) === slot && !this.disposed;
    if (slot.work === null) {
      const chars = await this.o.text.rawText(slot.index);
      if (!live()) return;
      const ranges = wordStartRanges(chars);
      slot.work = { ranges, chunks: wordStartChunks(ranges, CHARS_PER_CALL), next: 0, kept: [] };
    }
    const w = slot.work;
    const chunk = w.chunks[w.next];
    if (chunk !== undefined) {
      const outlines = await this.o.backend.getGlyphOutlines(this.o.doc, slot.index, chunk.start, chunk.end - chunk.start);
      if (!live() || slot.work !== w) return;
      keepInRanges(outlines, chunk.ranges, w.kept);
      w.next++;
    }
    if (w.next < w.chunks.length) return;
    const strokeOf = (o: GlyphOutline) => ((o.fontWeight ?? 0) >= BOLD_FONT_WEIGHT ? WORD_STARTS_ON_BOLD_STROKE_EM : WORD_STARTS_STROKE_EM) * (o.fontSize ?? 0);
    slot.drawn = { glyphs: glyphPaths(w.kept, strokeOf, STROKE_QUANTUM_PT), hasText: w.ranges.length > 0 };
    slot.work = null;
    this.emit();
    this.tellIfEmpty(slot);
  }

  /** Waits until the page list has not scrolled for SCROLL_IDLE_MS and the engine is not drawing pages (renderIdle). */
  private async engineFree(): Promise<void> {
    for (;;) {
      const wait = this.lastScrollAt + SCROLL_IDLE_MS - performance.now();
      if (wait <= 0 && (this.o.renderIdle?.() ?? true)) return;
      await new Promise((resolve) => setTimeout(resolve, Math.max(wait, BUSY_RECHECK_MS)));
      if (this.disposed) return;
    }
  }
}

/**
 * The outlines whose char (a ligature's first char) is inside one of `ranges` (sorted, not overlapping), appended to
 * `out`. Both lists are in char order, so this is one walk.
 */
function keepInRanges(outlines: readonly GlyphOutline[], ranges: readonly BoldRange[], out: GlyphOutline[]): void {
  let r = 0;
  for (const o of outlines) {
    while (r < ranges.length && ranges[r].end <= o.charIndex) r++;
    const range = ranges[r];
    if (range === undefined) return;
    if (o.charIndex >= range.start) out.push(o);
  }
}

export interface WordStartsLayerProps {
  controller: WordStartsController;
  box: PageBox;
  ctx: PageLayerContext;
  /** The page's unrotated size and /Rotate (OpenResult.pages[box.index]). */
  page: PageSize;
}

/** One page's bold word starts. Nothing while the switch is off. See the file comment. */
export const WordStartsLayer = memo(function WordStartsLayer({ controller, box, ctx, page }: WordStartsLayerProps): JSX.Element | null {
  const index = box.index;
  const svg = useRef<SVGSVGElement>(null);
  const shown = useSyncExternalStore(controller.subscribe, () => controller.page(index));
  const on = shown !== null;
  useLayoutEffect(() => controller.attach(index, ctx), [controller, index, ctx]);
  useLayoutEffect(() => (on && svg.current ? controller.observe(index, svg.current) : undefined), [controller, index, ctx, on]);
  const drawn = shown !== null && shown.glyphs.length > 0;
  useLayoutEffect(() => {
    if (drawn) performance.mark(WORD_STARTS_PERF_MARK, { detail: { pageIndex: index } });
  }, [drawn, shown, index]);
  if (shown === null) return null;
  const viewRotation = ((((box.rotation - page.rotation) % 360) + 360) % 360) as Rotation;
  const view = displayTransform(page, viewRotation);
  return (
    <svg
      ref={svg}
      className="sop-word-starts"
      aria-hidden="true"
      data-sop-word-starts-page={index}
      viewBox={`0 0 ${view.width} ${view.height}`}
      preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none' }}
    >
      <g transform={view.transform || undefined}>
        {shown.glyphs.map((g, n) => (
          <path key={n} d={g.d} fill={g.fill} stroke={g.stroke} strokeWidth={g.width} strokeLinejoin="round" />
        ))}
      </g>
    </svg>
  );
});
