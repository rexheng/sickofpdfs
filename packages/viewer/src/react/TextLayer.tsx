// The text layer of each page and the selection the viewer paints over it (Task 22; the selection model, TB1 polish).
//
// - Each page gets a pdf.js-style text layer (../text-layer) fed with PDFium's glyphs: invisible spans the browser
//   selects, copies and reads aloud. It is built lazily: once the page has been in view and its full render is on
//   screen, and once scrolling has paused (reading a page's glyphs takes the one engine worker 20–140 ms, and a page
//   drawn late is worse than a layer built late). It is destroyed with the page, outside the overscan.
// - The selection is a model of its own: two char positions (anchor and focus) anywhere in the document. It does not
//   live in the DOM, so it survives its pages' layers being destroyed: when a page comes back, its part of the selection
//   is painted and selected in the DOM again. The DOM selection shows the part of the model that has layers (for
//   screen readers, Shift+arrow keys and Find); a change someone else makes there (the keys, Find, a click outside the
//   pages) is read back into the model. A field that takes the focus (the page box, Find, a note) holds the DOM selection
//   for a while: the model waits, still painted, and is shown in the DOM again when the focus leaves the field. Ctrl+A
//   selects the whole document, and Copy writes the model's text, never what happens to be in the DOM (R26 joins, pages
//   joined by a line break; pages not on screen are read from the engine). Ctrl+C with nothing selected says so.
// - The browser's selection highlight is transparent. The viewer paints the selection itself (R44): the selected chars
//   → PDFium's line rectangles (getTextRangeRects) → one even band a line (markLineRects, the same rects marks are drawn
//   with, so a highlight lines up exactly with the selection it was made from) → one SVG path a page, in one colour,
//   under the text layer.
// - The viewer makes a mouse selection itself, from PDFium's char boxes, not the browser (R27): a drag selects whole
//   glyphs from the one under the mouse-down point to the one under the pointer. A press beside the text (in a margin,
//   the white space beside a line or between lines) starts at the nearest char of the nearest line; a pointer over no
//   text ends the selection at the nearest line's end (or start), preferring the column the drag started in. A
//   double-click selects the word, a triple-click the line (R28).
// - Caret browsing (R93, ./caret-browsing.ts): a text cursor on the same char model. Shift+keys move the selection's end
//   in PDFium's reading order (with the switch or after a mouse selection); with the switch on, a click puts the cursor
//   between two letters and the keys move it.
import { memo, useLayoutEffect, useRef } from 'react';
import { PdfEngineCrashedError } from '../backend/errors';
import type { PageGlyphs, PageSize, PdfRect } from '../backend/types';
import { cssPerPoint, displayedToPage, pageToDisplayed } from '../layout/page-space';
import type { PageBox } from '../layout/page-layout';
import { PT_TO_CSS } from '../layout/zoom';
import { highlightPath, markLineRects, normToCss, pdfRectToNorm, type RectSource } from '../marks/geometry';
import { charAtPoint, charRangeFromDomRange, type CharRange, domEndsOf, domPositionOfChar, getSelectionRanges } from '../text-layer/char-map';
import {
  buildTextItems,
  frame,
  type GlyphUnit,
  glyphUnits,
  lineAt,
  PDFIUM_HYPHEN,
  textModel,
  textModelSlice,
  trimPageText,
  wordAt,
} from '../text-layer/items';
import { loadTextLayerFont, measureTextLayerText, renderTextLayer, type TextLayerHandle } from '../text-layer/text-layer';
import '../text-layer/text-layer.css';
import { CaretBrowsing } from './caret-browsing';
import type { PageListApi } from './PageList';
import type { PageLayerContext } from './PageView';

/** Where the text layer reads a page's glyphs and selection rects: PdfBackend, or PageTextProvider (which caches). */
export interface TextLayerSource {
  glyphs(pageIndex: number): Promise<PageGlyphs>;
  /** getTextRangeRects: PDFium's merged line rects for chars [start, start + count), in points. */
  rects(pageIndex: number, start: number, count: number): Promise<PdfRect[]>;
  /**
   * getPageCopyText: a whole page as Copy writes it, and its char count. Copy reads pages that are not on screen with it
   * (Ctrl+A on a long book); without it they are read through `glyphs`, which costs several times as much.
   */
  copyText?(pageIndex: number): Promise<{ text: string; charCount: number }>;
}

export interface TextLayerControllerOptions {
  source: TextLayerSource;
  /** The document's pages (OpenResult.pages). */
  pages: PageSize[];
  /** The bundled layer font, pdf/NotoSans-Regular.ttf. */
  fontUrl: string;
  /** A short note for the reader (the viewer's snackbar): a long copy says it is working, then that it is done. */
  onNote?: (text: string) => void;
  /** Caret browsing (R93): the page list, for its layout and scrolling. Without it the caret cannot move. */
  pageList?: () => PageListApi | null;
  /** Caret browsing steps aside while this is true (presentation mode has the keys). */
  paused?: () => boolean;
  /** Whether a page is a scan: the caret skips pages with no text, with a note once a tab when they are scans. */
  isScannedPage?: (pageIndex: number) => Promise<boolean>;
}

/** A position between two chars: just before char `charIndex` of page `pageIndex`. PAGE_END: after the page's last char. */
export interface CharPos {
  pageIndex: number;
  charIndex: number;
}

/**
 * The selection as everything else reads it (Phase 2's marks, menu, notes and Search): the model, which outlives its
 * pages' text layers, never the DOM selection (which only holds the part on mounted pages).
 */
export interface TextSelectionSource {
  /** The chars selected, by page, in page order; [] for none (TextLayerController.selectionRanges). */
  ranges(): CharRange[];
  /** The selected text as Copy writes it, up to `maxChars`; it stops at a page whose text is not read yet. */
  text(maxChars?: number): string;
  /**
   * Where the selection starts (the top-left of its first painted line) or ends (the bottom-right of its last), in
   * client px, on the mounted pages; null when no part of it is painted on screen.
   */
  point(which: 'start' | 'end'): { x: number; y: number } | null;
  /** Lets go of the selection (the model and the DOM). Its paint goes in the same frame. */
  clear(): void;
  /** Selects the chars from `start` to `end` (a mark's text, for the mark menu's Comment). */
  select(start: CharPos, end: CharPos): void;
  /** Calls `cb` after the selection is set, changed or cleared (not on every move of a drag: once it ends). */
  subscribe(cb: () => void): () => void;
}

/** CharPos.charIndex (and CharRange.end) for the end of a page whose char count is not known yet. */
export const PAGE_END = Number.MAX_SAFE_INTEGER;

/** The selection: from `anchor` (where it began) to `focus` (where it was extended to), either way round. */
export interface TextSelection {
  anchor: CharPos;
  focus: CharPos;
}

/**
 * Text items are built for at least this many CSS px a point (200%): drift-split keeps every char edge within 0.5 px at
 * the scale it builds for, and less below it, so zooming out or up to 200% needs no rebuild.
 */
const REFERENCE_SCALE = 2 * PT_TO_CSS;
/** Above the scale the layer was built for, it is rebuilt once the zoom passes this factor. */
const REBUILD_ABOVE = 1.1;
/** Glyphs are read only after scrolling has paused this long. */
const SCROLL_IDLE_MS = 150;
/**
 * While a held key repeats, the selection it moves is shown in the DOM this long after the last repeat (setModel's
 * 'soon'): rewriting the DOM selection over thousands of spans is most of a key's cost, and only the browser and screen
 * readers read it. A single press shows it at once.
 */
const DOM_FOLLOW_MS = 120;
/** Selection rect requests a page may have with the engine at once (two, so a drag never waits for a whole round trip). */
const RECT_REQUESTS_IN_FLIGHT = 2;
/** A mouse-down that moves less than this is a click, not a drag. */
const DRAG_MIN_PX = 3;
/** Glyph arrays kept for pages no longer mounted (about 300 bytes a char). */
const GLYPH_PAGES_KEPT = 8;
/** A press this far (CSS px) outside a page's box, on the dark background beside it, still starts a selection on it. */
const START_PAGE_REACH_PX = 48;
/**
 * A press in the white space between lines starts on the nearest line within this many points (two lines of 10/12 text);
 * a press level with a line starts on it wherever it is across the page (the margins beside it). Farther away, a press
 * is a click on the page (it clears the selection).
 */
const START_REACH_PT = 24;
/** A gap along a line wider than this many line heights splits it into pieces (columns, table cells): see linesOf. */
const LINE_SPLIT_GAP = 1.5;
/** A drag scrolls the pages when the pointer is this close (CSS px) to the edge of the page area, or beyond it. */
const AUTOSCROLL_EDGE_PX = 6;
/** What Ctrl+C says when nothing is selected. */
export const NOTHING_TO_COPY = 'Nothing is selected, so nothing was copied.';
/** Autoscroll speed: this share of the distance past the edge each frame, between the two bounds (CSS px a frame). */
const AUTOSCROLL_GAIN = 0.5;
const AUTOSCROLL_MIN_PX = 2;
const AUTOSCROLL_MAX_PX = 48;

interface PageState {
  index: number;
  size: PageSize;
  host: HTMLElement;
  path: SVGPathElement;
  /** Where caret browsing draws its caret on this page. */
  caret: HTMLElement | null;
  box: PageBox | null;
  ctx: PageLayerContext | null;
  handle: TextLayerHandle | null;
  /** The scale (CSS px a point) the layer's items were built for. */
  builtScale: number;
  visible: boolean;
  building: boolean;
  disposed: boolean;
  /** The selected chars on this page, as last painted (`start:end`, '' for none), and their normalised rects. */
  selKey: string;
  selRects: PdfRect[] | null;
  /** Rect requests made for this page, the newest one drawn, and how many are still with the engine. */
  selIssued: number;
  selDrawn: number;
  /** The selection (`start:end`) of the newest request. */
  selAsked: string;
  selInflight: number;
}

/** What one page's TextLayer component holds. */
export interface PageTextLayer {
  setView(box: PageBox, ctx: PageLayerContext): void;
  dispose(): void;
}

/**
 * A selection end found at a point: a glyph (chars [start, end), a surrogate pair is two), which a selection takes whole
 * whichever way it runs; or, with `caret`, the position just before `start` or just after `end` (a press or a pointer
 * beside a line: before its first char, after its last).
 */
interface End {
  pageIndex: number;
  start: number;
  end: number;
  caret?: 'before' | 'after';
}

/** One line of a page as the pointer meets it: its glyphs with boxes, in char order, along the line's own direction. */
interface TextLine {
  units: GlyphUnit[];
  /** Each unit's extent along the line (û of `angle`, points), parallel to `units`. */
  along: [number, number][];
  angle: number;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  /** The chars run along +û (left to right on an upright page); false for right-to-left text. */
  forward: boolean;
}

interface Drag {
  /** Where the selection starts: the press point's end, or, after a Shift+press, the selection's anchor. */
  from: End | CharPos | null;
  x0: number;
  y0: number;
  x: number;
  y: number;
  moved: boolean;
}

const isPos = (e: End | CharPos): e is CharPos => 'charIndex' in e;
const cmpPos = (a: CharPos, b: CharPos) => a.pageIndex - b.pageIndex || a.charIndex - b.charIndex;
const sameRanges = (a: CharRange[], b: CharRange[]) =>
  a.length === b.length && a.every((r, i) => r.pageIndex === b[i].pageIndex && r.start === b[i].start && r.end === b[i].end);

/** An element whose own text the reader edits or selects: the page box, a find field, a note being written. */
function isEditable(el: Element | null): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLElement && el.isContentEditable);
}

/** A press there belongs to that control, not to the pages. */
const CONTROLS = 'input, textarea, select, button, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"], [role="menu"], [role="menuitem"]';

/** One per open document: the pages' text layers, the selection model and its painting, drags, word clicks and Copy. */
export class TextLayerController {
  /** The selection for Phase 2 (see TextSelectionSource). */
  readonly textSelection: TextSelectionSource;
  /** Caret browsing (R93): its switch, the caret, and the Shift+keys that move the selection's end. */
  readonly caret: CaretBrowsing;
  private readonly selectionListeners = new Set<() => void>();
  private readonly pages = new Map<number, PageState>();
  private readonly glyphCache = new Map<number, PageGlyphs>();
  private readonly glyphLoads = new Map<number, Promise<PageGlyphs>>();
  private readonly units = new WeakMap<PageGlyphs, GlyphUnit[]>();
  private readonly lines = new WeakMap<PageGlyphs, TextLine[]>();
  private readonly readyWaiters = new Map<number, (() => void)[]>();
  private fontReady: Promise<void> | null = null;
  private readonly rectSource: RectSource;
  private root: HTMLElement | null = null;
  private observer: IntersectionObserver | null = null;
  private listeners: AbortController | null = null;
  private lastScrollAt = -Infinity;
  private glyphQueue: Promise<unknown> = Promise.resolve();
  private drag: Drag | null = null;
  private paintFrame = 0;
  /** Set while the DOM selection is behind the model (setModel 'soon'), until it is shown there. */
  private domFollow: ReturnType<typeof setTimeout> | null = null;
  private scrollFrame = 0;
  /** The pointer's last position, with the fraction of a pixel that pointer events keep and mouse events drop. */
  private pointer: { x: number; y: number } | null = null;
  /** The selection; null for none. */
  private model: TextSelection | null = null;
  /** Each page's char count, once known (glyphs, or a page read for Copy). */
  private readonly charCounts = new Map<number, number>();
  /** Whole pages as Copy writes them (strings only: about 2 bytes a char), kept for the document's life. */
  private readonly pageTexts = new Map<number, string>();
  /** The text model of the pages a selection ends on part-way, so Copy can cut them after their glyphs are dropped. */
  private readonly endModels = new Map<number, string[]>();
  /** Pages being read for Copy. */
  private readonly textLoads = new Map<number, Promise<void>>();
  /** Where the last plain click (a press that did not drag) landed: a Shift+click with no selection extends from there. */
  private clickedAt: End | null = null;
  /** Pages whose text changed while their layer was being built (refreshPage): built again once that build ends. */
  private readonly stale = new Set<number>();

  constructor(private readonly o: TextLayerControllerOptions) {
    this.rectSource = {
      rects: (p, s, c) => o.source.rects(p, s, c),
      glyphs: (p) => this.glyphs(p),
    };
    this.textSelection = {
      ranges: () => this.selectionRanges(),
      text: (maxChars = Infinity) => (this.model ? (this.copyText(this.model, maxChars) ?? '') : ''),
      point: (which) => this.paintedPoint(which),
      clear: () => {
        this.clickedAt = null;
        this.setModel(null);
        // A mark that takes the selection's place is drawn in this frame (R71): the selection's paint must go with it,
        // not a frame later.
        this.paintNow();
      },
      select: (start, end) => {
        this.clickedAt = null;
        this.setModel({ anchor: start, focus: end });
      },
      subscribe: (cb) => {
        this.selectionListeners.add(cb);
        return () => this.selectionListeners.delete(cb);
      },
    };
    this.caret = new CaretBrowsing(
      {
        pages: o.pages,
        cachedGlyphs: (i) => this.glyphCache.get(i),
        glyphs: (i) => this.glyphs(i),
        selection: () => this.model,
        select: (sel, soon) => {
          this.clickedAt = null;
          this.setModel(sel, sel && soon ? 'soon' : true);
        },
        mounted: (i) => {
          const s = this.pages.get(i);
          return s?.box && s.caret ? { box: s.box, caret: s.caret } : null;
        },
        scroller: () => this.root,
        pageList: () => o.pageList?.() ?? null,
        paused: () => o.paused?.() ?? false,
        ...(o.isScannedPage ? { isScannedPage: o.isScannedPage } : {}),
        ...(o.onNote ? { note: o.onNote } : {}),
      },
      (cb) => this.textSelection.subscribe(cb),
    );
  }

  /** Registers a page's layer host, selection path and caret (TextLayer does this). */
  mount(index: number, host: HTMLElement, path: SVGPathElement, caret: HTMLElement | null = null): PageTextLayer {
    const s: PageState = {
      index,
      size: this.o.pages[index],
      host,
      path,
      caret,
      box: null,
      ctx: null,
      handle: null,
      builtScale: 0,
      visible: false,
      building: false,
      disposed: false,
      selKey: '',
      selRects: null,
      selIssued: 0,
      selDrawn: 0,
      selAsked: '',
      selInflight: 0,
    };
    this.pages.set(index, s);
    this.root ??= host.closest<HTMLElement>('[role="document"]') ?? document.body;
    this.install();
    this.observer?.observe(host);
    this.schedulePaint();
    return {
      setView: (box, ctx) => {
        if (s.disposed) return;
        s.box = box;
        s.ctx = ctx;
        s.handle?.update(this.scaleOf(s), box.rotation);
        this.draw(s);
        this.caret.pageShown(index);
        void this.ensureBuilt(s);
      },
      dispose: () => {
        // The DOM selection loses this page's part with its layer: read any change the reader made first, and show the
        // model again on the layers that stay. The model itself keeps the page.
        this.syncFromDom();
        s.disposed = true;
        this.observer?.unobserve(host);
        if (this.pages.get(index) === s) this.pages.delete(index);
        s.handle?.destroy();
        s.handle = null;
        if (this.pages.size === 0) this.uninstall();
        else this.applyModel();
      },
    };
  }

  /**
   * The chars the selection covers, page by page (CharRange per page, in page order). A page whose char count is not
   * known yet (one never shown, in a Ctrl+A selection) ends at PAGE_END.
   */
  selectionRanges(): CharRange[] {
    return this.rangesOf(this.model);
  }

  /** Selects the whole document, as Ctrl+A does in the pages. */
  selectAll(): void {
    const last = this.o.pages.length - 1;
    if (last < 0) return;
    this.setModel({ anchor: { pageIndex: 0, charIndex: 0 }, focus: { pageIndex: last, charIndex: PAGE_END } });
  }

  /** The centre of char `charIndex`'s PDFium box on page `pageIndex`, in client px; NaN when its layer is not built. */
  glyphCenter(pageIndex: number, charIndex: number): { x: number; y: number } {
    const s = this.pages.get(pageIndex);
    const g = this.glyphCache.get(pageIndex);
    const pageEl = s?.host.closest<HTMLElement>('[data-page-index]');
    const unit = g ? this.unitsOf(g).find((u) => charIndex >= u.start && charIndex < u.end) : undefined;
    if (!s?.box || !pageEl || !unit) return { x: NaN, y: NaN };
    if (!unit.box) return this.shownCenter(s, unit.start); // a generated space: where the layer shows it
    const k = this.scaleOf(s);
    const b = unit.box;
    const d = pageToDisplayed(b.x + b.width / 2, b.y + b.height / 2, s.box.rotation, s.size.width, s.size.height);
    const r = pageEl.getBoundingClientRect();
    return { x: r.left + d.x * k, y: r.top + d.y * k };
  }

  /** The centre of a char the layer shows but PDFium has no box for (a generated space), from the DOM. */
  private shownCenter(s: PageState, charIndex: number): { x: number; y: number } {
    const pos = this.root && s.handle ? domPositionOfChar(this.root, s.index, charIndex, 'before') : null;
    if (!pos) return { x: NaN, y: NaN };
    const r = document.createRange();
    r.setStart(pos.node, pos.offset);
    r.setEnd(pos.node, Math.min(pos.node.length, pos.offset + 1));
    const b = r.getBoundingClientRect();
    return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
  }

  /** Resolves once page `pageIndex` has a text layer built for the current zoom. */
  whenReady(pageIndex: number): Promise<void> {
    const s = this.pages.get(pageIndex);
    if (s && this.isReady(s)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.readyWaiters.get(pageIndex) ?? [];
      list.push(resolve);
      this.readyWaiters.set(pageIndex, list);
    });
  }

  /**
   * The page's text changed under it (Phase 7: its recognised text arrived, or was replaced): everything read from its old
   * text is dropped, and its layer is built again from the new glyphs. A selection on the page is let go of, since its char
   * positions belonged to the old text.
   */
  refreshPage(pageIndex: number): void {
    this.glyphCache.delete(pageIndex);
    this.glyphLoads.delete(pageIndex);
    this.charCounts.delete(pageIndex);
    this.pageTexts.delete(pageIndex);
    this.endModels.delete(pageIndex);
    if (this.model && this.rangesOf(this.model).some((r) => r.pageIndex === pageIndex)) this.setModel(null);
    const s = this.pages.get(pageIndex);
    if (!s) return;
    if (s.building) {
      this.stale.add(pageIndex);
      return;
    }
    s.builtScale = 0;
    s.handle?.destroy();
    s.handle = null;
    void this.ensureBuilt(s);
  }

  dispose(): void {
    for (const s of [...this.pages.values()]) {
      s.disposed = true;
      s.handle?.destroy();
    }
    this.pages.clear();
    this.uninstall();
    this.caret.dispose();
  }

  // ---- building ----

  /** CSS px a point for the page's current box. */
  private scaleOf(s: PageState): number {
    return s.box ? cssPerPoint(s.box, s.size) : 0;
  }

  private isReady(s: PageState): boolean {
    return s.handle !== null && !s.building && this.scaleOf(s) <= s.builtScale * REBUILD_ABOVE;
  }

  /** Builds (or rebuilds, after zooming in past the built scale) the page's layer once it has been in view. */
  private async ensureBuilt(s: PageState): Promise<void> {
    if (s.building || s.disposed || !s.visible || !s.ctx || this.isReady(s)) return;
    s.building = true;
    try {
      // Loaded with the first layer, after the first page is drawn, so it never competes with that.
      this.fontReady ??= loadTextLayerFont(this.o.fontUrl).catch((err: unknown) => {
        // Without the font the layer still works; its char edges are only as good as the fallback font's.
        console.error('sickofpdfs: the text-layer font did not load', err);
      });
      await this.fontReady;
      await s.ctx.whenPainted();
      await this.scrollIdle();
      if (s.disposed) return;
      const glyphs = await this.queueGlyphs(s.index);
      if (s.disposed || !s.box) return;
      const k = this.scaleOf(s);
      const scale = Math.max(k, REFERENCE_SCALE);
      const items = buildTextItems(glyphs, measureTextLayerText, scale);
      // A rebuild drops the old layer's DOM selection: read any change made there first. The model is put back below.
      if (s.handle) this.syncFromDom();
      s.handle?.destroy();
      const turned = s.box.rotation % 180 !== 0;
      const box: PageBox = { ...s.box, width: (turned ? s.size.height : s.size.width) * scale, height: (turned ? s.size.width : s.size.height) * scale };
      s.handle = renderTextLayer(s.host, items, box, s.index);
      s.handle.update(k, s.box.rotation);
      s.builtScale = scale;
      this.applyModel();
    } catch (err) {
      // An engine crash is the page list's to report (once), not every page's.
      if (!s.disposed && !(err instanceof PdfEngineCrashedError)) console.error(`sickofpdfs: the text layer of page ${s.index + 1} could not be built`, err);
      return;
    } finally {
      s.building = false;
    }
    if (this.stale.delete(s.index)) {
      this.refreshPage(s.index);
      return;
    }
    if (this.isReady(s)) {
      this.caret.warm(s.index);
      const waiters = this.readyWaiters.get(s.index) ?? [];
      this.readyWaiters.delete(s.index);
      for (const w of waiters) w();
      this.schedulePaint();
    } else {
      void this.ensureBuilt(s); // the zoom moved on while it was building
    }
  }

  /** Waits until the page list has not scrolled for SCROLL_IDLE_MS. */
  private async scrollIdle(): Promise<void> {
    for (;;) {
      const wait = this.lastScrollAt + SCROLL_IDLE_MS - performance.now();
      if (wait <= 0) return;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  /** The page's glyphs, read one page at a time (each read holds the engine worker). */
  private queueGlyphs(index: number): Promise<PageGlyphs> {
    const cached = this.glyphCache.get(index);
    if (cached) return Promise.resolve(cached);
    const p = this.glyphQueue.then(() => this.glyphs(index));
    this.glyphQueue = p.catch(() => {});
    return p;
  }

  /** The page's glyphs, cached for the mounted pages and the last few others. */
  private glyphs(index: number): Promise<PageGlyphs> {
    const cached = this.glyphCache.get(index);
    if (cached) {
      this.glyphCache.delete(index);
      this.glyphCache.set(index, cached);
      return Promise.resolve(cached);
    }
    let load = this.glyphLoads.get(index);
    if (!load) {
      load = this.o.source.glyphs(index).then(
        (g) => {
          this.glyphLoads.delete(index);
          this.glyphCache.set(index, g);
          this.charCounts.set(index, g.glyphs.length);
          for (const key of this.glyphCache.keys()) {
            if (this.glyphCache.size <= GLYPH_PAGES_KEPT + this.pages.size) break;
            if (!this.pages.has(key)) this.glyphCache.delete(key);
          }
          return g;
        },
        (err: unknown) => {
          this.glyphLoads.delete(index);
          throw err;
        },
      );
      this.glyphLoads.set(index, load);
    }
    return load;
  }

  private unitsOf(g: PageGlyphs): GlyphUnit[] {
    let u = this.units.get(g);
    if (!u) this.units.set(g, (u = glyphUnits(g)));
    return u;
  }

  /**
   * The page's lines as the pointer meets them: runs of glyphs with boxes between PDFium's line breaks. A line also ends
   * after PDFium's joined line-end hyphen (it joins the word across the two lines with no break of its own), where the
   * direction changes, where the next glyph is not on the line's band, and at a gap wider than LINE_SPLIT_GAP line
   * heights (two columns, or table cells, that PDFium put on one line). Generated spaces have no box and are left out.
   */
  private linesOf(g: PageGlyphs): TextLine[] {
    const hit = this.lines.get(g);
    if (hit) return hit;
    const out: TextLine[] = [];
    let cur: TextLine | null = null;
    const close = () => {
      if (cur && cur.units.length > 0) {
        const first = cur.along[0];
        const last = cur.along[cur.along.length - 1];
        cur.forward = cur.units.length === 1 ? true : last[0] + last[1] >= first[0] + first[1];
        out.push(cur);
      }
      cur = null;
    };
    for (const u of this.unitsOf(g)) {
      if (u.lineBreak) {
        close();
        continue;
      }
      if (u.hidden || !u.box) continue;
      if (cur) {
        const c: TextLine = cur;
        const f = frame(u.box, c.angle);
        const delta = Math.abs(u.angle - c.angle) % 360;
        const across = Math.min(c.v1, f.v1) - Math.max(c.v0, f.v0);
        const height = Math.min(c.v1 - c.v0, f.v1 - f.v0);
        const prev = c.along[c.along.length - 1];
        const gap = Math.max(f.u0 - prev[1], prev[0] - f.u1);
        if (Math.min(delta, 360 - delta) > 0.5 || across < 0.3 * height || gap > LINE_SPLIT_GAP * (c.v1 - c.v0)) close();
      }
      if (!cur) cur = { units: [], along: [], angle: u.angle, u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity, forward: true };
      const line: TextLine = cur;
      const f = frame(u.box, line.angle);
      line.units.push(u);
      line.along.push([f.u0, f.u1]);
      line.u0 = Math.min(line.u0, f.u0);
      line.u1 = Math.max(line.u1, f.u1);
      line.v0 = Math.min(line.v0, f.v0);
      line.v1 = Math.max(line.v1, f.v1);
      if (u.text === PDFIUM_HYPHEN) close();
    }
    close();
    this.lines.set(g, out);
    return out;
  }

  // ---- the selection model ----

  /** The model's two ends in document order. */
  private ordered(m: TextSelection): [CharPos, CharPos] {
    return cmpPos(m.anchor, m.focus) <= 0 ? [m.anchor, m.focus] : [m.focus, m.anchor];
  }

  /** A page's char count: from its glyphs, or from a read for Copy; undefined while unknown. */
  private countOf(pageIndex: number): number | undefined {
    return this.glyphCache.get(pageIndex)?.glyphs.length ?? this.charCounts.get(pageIndex);
  }

  /** The model's chars on page `p`, or null (an end at PAGE_END is the page's count when known). */
  private rangeOn(m: TextSelection, p: number): CharRange | null {
    const [lo, hi] = this.ordered(m);
    if (p < lo.pageIndex || p > hi.pageIndex) return null;
    const n = this.countOf(p);
    const start = p === lo.pageIndex ? lo.charIndex : 0;
    let end = p === hi.pageIndex ? hi.charIndex : PAGE_END;
    if (end === PAGE_END && n !== undefined) end = n;
    if (n !== undefined) end = Math.min(end, n);
    return end > start ? { pageIndex: p, start, end } : null;
  }

  private rangesOf(m: TextSelection | null): CharRange[] {
    if (!m) return [];
    const [lo, hi] = this.ordered(m);
    const out: CharRange[] = [];
    for (let p = lo.pageIndex; p <= hi.pageIndex; p++) {
      const r = this.rangeOn(m, p);
      if (r) out.push(r);
    }
    return out;
  }

  /**
   * Makes `next` the selection (null or an empty one clears it): it is painted, shown in the DOM where its pages have
   * layers (unless `dom` is false; with 'soon', once the keys pause: DOM_FOLLOW_MS), and Copy starts reading the pages
   * it needs. Painting, Copy, the marks and the notes read the model, never the DOM.
   */
  private setModel(next: TextSelection | null, dom: boolean | 'soon' = true): void {
    const was = this.model;
    this.model = next && cmpPos(next.anchor, next.focus) !== 0 ? next : null;
    if (dom === 'soon') {
      if (this.domFollow !== null) clearTimeout(this.domFollow);
      this.domFollow = setTimeout(() => {
        this.domFollow = null;
        this.applyModel();
      }, DOM_FOLLOW_MS);
    } else if (dom) {
      if (this.domFollow !== null) clearTimeout(this.domFollow);
      this.domFollow = null;
      this.applyModel();
    }
    this.prepareCopy();
    this.schedulePaint();
    const same = was === this.model || (was && this.model && cmpPos(was.anchor, this.model.anchor) === 0 && cmpPos(was.focus, this.model.focus) === 0);
    if (!same) for (const cb of [...this.selectionListeners]) cb();
  }

  /** The DOM selection's ends that show the model on the layers built now (null when none of it has a layer). */
  private shownEnds(): { anchor: { node: Text; offset: number }; focus: { node: Text; offset: number } } | null {
    const m = this.model;
    const root = this.root;
    if (!m || !root) return null;
    const built = [...this.pages.values()].filter((s) => s.handle !== null).map((s) => s.index);
    const ranges = built.map((p) => this.rangeOn(m, p)).filter((r): r is CharRange => r !== null);
    const ends = domEndsOf(root, ranges);
    if (!ends) return null;
    const backward = cmpPos(m.anchor, m.focus) > 0;
    return backward ? { anchor: ends.end, focus: ends.start } : { anchor: ends.start, focus: ends.end };
  }

  /** What getSelectionRanges reads once the model is shown in the DOM (see shownEnds). */
  private shownRanges(): CharRange[] {
    const ends = this.shownEnds();
    if (!ends || !this.root) return [];
    const r = document.createRange();
    r.setStart(ends.anchor.node, ends.anchor.offset);
    if (r.comparePoint(ends.focus.node, ends.focus.offset) >= 0) r.setEnd(ends.focus.node, ends.focus.offset);
    else r.setStart(ends.focus.node, ends.focus.offset);
    return charRangeFromDomRange(this.root, r);
  }

  /**
   * Shows the model in the DOM selection, on the pages that have layers. Never while the focus is in a field (that would
   * take the reader's caret out of it); the painting does not need the DOM. `fieldLeft`: a field has just given the focus
   * back, and whatever it left in the DOM selection is not the reader's.
   */
  private applyModel(fieldLeft = false): void {
    const root = this.root;
    const sel = document.getSelection();
    if (!root || !sel || this.drag || isEditable(document.activeElement)) return;
    const ends = this.shownEnds();
    if (!ends) {
      // Nothing of the model has a layer (or there is none): no selection in the layers. A model kept for pages that are
      // gone leaves a collapsed selection (so it is not mistaken for the reader clearing it).
      if (sel.rangeCount > 0 && getSelectionRanges(root).length > 0) {
        if (this.model) sel.collapse(root, 0);
        else sel.removeAllRanges();
      } else if (fieldLeft && this.model && sel.rangeCount > 0 && !sel.isCollapsed) {
        sel.collapse(root, 0);
      }
      return;
    }
    if (sameRanges(getSelectionRanges(root), this.shownRanges()) && sel.anchorNode === ends.anchor.node && sel.anchorOffset === ends.anchor.offset) return;
    sel.setBaseAndExtent(ends.anchor.node, ends.anchor.offset, ends.focus.node, ends.focus.offset);
  }

  /**
   * Reads a change someone else made to the DOM selection into the model: the keys (Shift+arrows), Find selecting a
   * hit, a selection made outside the pages, a field taking the focus, code clearing it. A DOM selection that still
   * shows the model (the model may reach pages that have no layer) changes nothing.
   */
  private syncFromDom(): void {
    const root = this.root;
    // While the DOM selection is behind the model (keys moving it), what the DOM says is old news, not a change.
    if (!root || this.drag || this.domFollow !== null) return;
    const sel = document.getSelection();
    const dom = getSelectionRanges(root);
    // A field with the focus holds the DOM selection (its caret, or text selected in it): that is not the reader letting
    // go of the selection. The model stays, painted, and is shown again when the focus leaves the field (onFocusOut), as
    // Chrome's viewer keeps its selection while its page box is used. So a far jump by Go to page keeps it, and Ctrl+C
    // there copies it. Code clearing the selection (no range at all) still clears it.
    if (dom.length === 0 && sel !== null && sel.rangeCount > 0 && isEditable(document.activeElement)) return;
    const shown = this.shownRanges();
    if (sameRanges(dom, shown)) {
      // The same chars, but a selection elsewhere replaces one that is not on screen.
      const elsewhere = sel !== null && sel.rangeCount > 0 && !sel.isCollapsed;
      const cleared = sel === null || sel.rangeCount === 0;
      if (dom.length === 0 && this.model && (elsewhere || cleared)) this.setModel(null, false);
      return;
    }
    if (!sel || sel.rangeCount === 0 || dom.length === 0) {
      this.setModel(null, false);
      return;
    }
    const first = dom[0];
    const last = dom[dom.length - 1];
    let lo: CharPos = { pageIndex: first.pageIndex, charIndex: first.start };
    let hi: CharPos = { pageIndex: last.pageIndex, charIndex: last.end };
    // An end the DOM could not move (it sits where the model's shown part began or ended) keeps the model's own end,
    // which may be on a page with no layer.
    const m = this.model;
    if (m && shown.length > 0) {
      const [mlo, mhi] = this.ordered(m);
      const s0 = shown[0];
      const s1 = shown[shown.length - 1];
      if (s0.pageIndex === first.pageIndex && s0.start === first.start) lo = mlo;
      if (s1.pageIndex === last.pageIndex && s1.end === last.end) hi = mhi;
    }
    let backward = false;
    if (sel.anchorNode && sel.focusNode) {
      const r = document.createRange();
      r.setStart(sel.anchorNode, sel.anchorOffset);
      backward = r.comparePoint(sel.focusNode, sel.focusOffset) < 0;
    }
    this.setModel(backward ? { anchor: hi, focus: lo } : { anchor: lo, focus: hi }, false);
  }

  // ---- selection: painting ----

  /** Paints the model now instead of in the next frame (requests for rects still answer later). */
  private paintNow(): void {
    if (this.paintFrame) cancelAnimationFrame(this.paintFrame);
    this.paintFrame = 0;
    this.paint();
  }

  private schedulePaint(): void {
    if (this.paintFrame) return;
    this.paintFrame = requestAnimationFrame(() => {
      this.paintFrame = 0;
      this.paint();
    });
  }

  private paint(): void {
    const m = this.model;
    for (const s of this.pages.values()) {
      // A page whose glyphs are not read yet is painted once its layer is built.
      const r = m && this.glyphCache.has(s.index) ? this.rangeOn(m, s.index) : null;
      const key = r ? `${r.start}:${r.end}` : '';
      if (key === s.selKey) continue;
      s.selKey = key;
      if (!r) {
        s.selRects = null;
        this.draw(s);
      } else {
        this.requestRects(s);
      }
    }
  }

  /**
   * Fetches the rects of the page's current selection. Up to RECT_REQUESTS_IN_FLIGHT requests are with the engine at
   * once; an answer is drawn only if no newer one has been, and when the selection has moved on meanwhile it is asked
   * for again.
   */
  private requestRects(s: PageState): void {
    if (s.selInflight >= RECT_REQUESTS_IN_FLIGHT) return;
    const key = s.selKey;
    const [start, end] = key.split(':').map(Number) as [number, number];
    const seq = ++s.selIssued;
    s.selAsked = key;
    s.selInflight++;
    markLineRects(this.rectSource, s.index, start, end - start).then(
      (rects) => {
        s.selInflight--;
        if (s.disposed) return;
        if (seq > s.selDrawn && s.selKey !== '') {
          s.selDrawn = seq;
          s.selRects = rects;
          this.draw(s);
        }
        if (s.selKey !== '' && s.selKey !== s.selAsked) this.requestRects(s);
      },
      (err: unknown) => {
        s.selInflight--;
        if (!s.disposed && !(err instanceof PdfEngineCrashedError)) console.error('sickofpdfs: the selection could not be drawn', err);
      },
    );
  }

  /** The corner of the selection's first (or last) painted line on the mounted pages, in client px (TextSelectionSource.point). */
  private paintedPoint(which: 'start' | 'end'): { x: number; y: number } | null {
    let best: { s: PageState; boxes: { x: number; y: number; width: number; height: number }[] } | null = null;
    for (const s of this.pages.values()) {
      if (!s.box || !s.selRects || s.selRects.length === 0 || s.selKey === '') continue;
      if (best && (which === 'start' ? s.index > best.s.index : s.index < best.s.index)) continue;
      const k = this.scaleOf(s);
      best = { s, boxes: s.selRects.map((r) => normToCss(pdfRectToNorm(r, s.size), s.size, k, s.box!.rotation)) };
    }
    const pageEl = best?.s.host.closest<HTMLElement>('[data-page-index]');
    if (!best || !pageEl) return null;
    const r = pageEl.getBoundingClientRect();
    const b = which === 'start' ? best.boxes[0] : best.boxes[best.boxes.length - 1];
    return which === 'start' ? { x: r.left + b.x, y: r.top + b.y } : { x: r.left + b.x + b.width, y: r.top + b.y + b.height };
  }

  /** The page's selection path: its rects on the displayed page, edges on whole device pixels. */
  private draw(s: PageState): void {
    if (!s.box || !s.ctx || !s.selRects || s.selKey === '') {
      s.path.setAttribute('d', '');
      return;
    }
    const k = this.scaleOf(s);
    const boxes = s.selRects.map((r) => normToCss(pdfRectToNorm(r, s.size), s.size, k, s.box!.rotation));
    s.path.setAttribute('d', highlightPath(boxes, { pixelRatio: s.ctx.dpr }));
  }

  // ---- selection: the pointer ----

  private install(): void {
    if (this.listeners) return;
    this.listeners = new AbortController();
    const signal = this.listeners.signal;
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const s = [...this.pages.values()].find((p) => p.host === e.target);
        if (!s) continue;
        s.visible = true;
        void this.ensureBuilt(s);
      }
    });
    for (const s of this.pages.values()) this.observer.observe(s.host);
    document.addEventListener('selectionchange', () => this.syncFromDom(), { signal });
    document.addEventListener('scroll', () => (this.lastScrollAt = performance.now()), { signal, capture: true, passive: true });
    const notePointer = (e: PointerEvent) => (this.pointer = { x: e.clientX, y: e.clientY });
    document.addEventListener('pointerdown', notePointer, { signal, capture: true, passive: true });
    document.addEventListener('pointermove', notePointer, { signal, capture: true, passive: true });
    document.addEventListener('pointerup', notePointer, { signal, capture: true, passive: true });
    document.addEventListener('mousedown', (e) => this.onMouseDown(e), { signal, capture: true });
    document.addEventListener('mousemove', (e) => this.onMouseMove(e), { signal, passive: true });
    document.addEventListener('mouseup', (e) => this.onMouseUp(e), { signal });
    window.addEventListener('blur', () => this.endDrag(), { signal });
    document.addEventListener('keydown', (e) => this.onKeyDown(e), { signal });
    document.addEventListener('focusout', (e) => this.onFocusOut(e), { signal });
    document.addEventListener('copy', (e) => this.onCopy(e), { signal });
  }

  private uninstall(): void {
    this.listeners?.abort();
    this.listeners = null;
    this.observer?.disconnect();
    this.observer = null;
    if (this.paintFrame) cancelAnimationFrame(this.paintFrame);
    this.paintFrame = 0;
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = 0;
    if (this.domFollow !== null) clearTimeout(this.domFollow);
    this.domFollow = null;
    this.drag = null;
  }

  /**
   * Where a mouse event happened. Chrome gives MouseEvent.clientX and clientY in whole CSS pixels, which can put a press
   * on the left edge of a narrow letter onto the letter before it (a CSS pixel is two device pixels on a 2× screen). The
   * pointer event that comes just before it has the same point with its fraction; use that when it matches.
   */
  private at(e: MouseEvent): { x: number; y: number } {
    const p = this.pointer;
    return p && Math.abs(p.x - e.clientX) < 1 && Math.abs(p.y - e.clientY) < 1 ? p : { x: e.clientX, y: e.clientY };
  }

  /** A press on the pages (a page, the background between and beside them), not on a control or the scroll bars. */
  private onPages(e: MouseEvent): boolean {
    const root = this.root;
    const t = e.target;
    if (!root || !(t instanceof Element) || !root.contains(t) || t.closest(CONTROLS)) return false;
    if (t !== root && t.parentElement !== root && !t.closest('[data-page-index]')) return false;
    const r = root.getBoundingClientRect();
    return e.clientX < r.left + root.clientLeft + root.clientWidth && e.clientY < r.top + root.clientTop + root.clientHeight;
  }

  /** The mounted pages whose glyphs are read, with their client rects (nearest to the point first). */
  private pagesNear(x: number, y: number): { s: PageState; g: PageGlyphs; rect: DOMRect; distance: number }[] {
    const out: { s: PageState; g: PageGlyphs; rect: DOMRect; distance: number }[] = [];
    for (const s of this.pages.values()) {
      const g = this.glyphCache.get(s.index);
      const pageEl = s.host.closest<HTMLElement>('[data-page-index]');
      if (!s.box || !g || !pageEl || !(this.scaleOf(s) > 0)) continue;
      const rect = pageEl.getBoundingClientRect();
      const dx = Math.max(rect.left - x, 0, x - rect.right);
      const dy = Math.max(rect.top - y, 0, y - rect.bottom);
      out.push({ s, g, rect, distance: Math.hypot(dx, dy) });
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  /** A client point on page `s` in points (unrotated page space). */
  private toPage(s: PageState, rect: DOMRect, x: number, y: number): { x: number; y: number } {
    const k = this.scaleOf(s);
    return displayedToPage((x - rect.left) / k, (y - rect.top) / k, s.box!.rotation, s.size.width, s.size.height);
  }

  /**
   * The glyph whose PDFium box holds page point `p` (Chrome's viewer also hit-tests PDFium's boxes, R27), not the layer's
   * DOM boxes, which may be up to half a pixel off: a press just inside a glyph's edge is on that glyph. Where boxes
   * overlap (kerning, italics), the one whose centre is nearest. PDFium's joined hyphen and chars with no text count only
   * with `withHyphen`.
   */
  private glyphAt(g: PageGlyphs, p: { x: number; y: number }, withHyphen = false): GlyphUnit | null {
    let inside: { u: GlyphUnit; d: number } | null = null;
    for (const u of this.unitsOf(g)) {
      const b = u.box;
      if (!b || u.hidden || u.lineBreak || (u.hyphen && !withHyphen)) continue;
      if (p.x < b.x || p.x > b.x + b.width || p.y < b.y || p.y > b.y + b.height) continue;
      const c = Math.hypot(p.x - (b.x + b.width / 2), p.y - (b.y + b.height / 2));
      if (!inside || c < inside.d) inside = { u, d: c };
    }
    return inside?.u ?? null;
  }

  /** The char under a client point (by PDFium's boxes, then by the layer's DOM), for word and line clicks. */
  private hitChar(x: number, y: number, withHyphen: boolean): { pageIndex: number; charIndex: number } | null {
    for (const { s, g, rect, distance } of this.pagesNear(x, y)) {
      if (distance > 0) break;
      const u = this.glyphAt(g, this.toPage(s, rect, x, y), withHyphen);
      if (u) return { pageIndex: s.index, charIndex: u.start };
    }
    return this.root ? charAtPoint(this.root, x, y, withHyphen) : null;
  }

  /** The line of a page that holds char `charIndex` (or the nearest one before it), for the column a drag started in. */
  private lineOfChar(pageIndex: number, charIndex: number): TextLine | null {
    const g = this.glyphCache.get(pageIndex);
    if (!g) return null;
    let best: TextLine | null = null;
    for (const line of this.linesOf(g)) {
      if (line.units[0].start > charIndex) break;
      best = line;
      if (line.units[line.units.length - 1].end > charIndex) break;
    }
    return best;
  }

  /**
   * The selection end at a client point.
   * - On a glyph: that glyph.
   * - Otherwise the nearest line, and on it: past its end, a caret after its last char; before its start, a caret before
   *   its first; else the nearest glyph along it. A line the point is level with comes first (the white space beside a
   *   line belongs to it); then the nearest line. Lines in `column` (those sharing part of its extent along the text) come
   *   first, unless the point is over another column's text.
   * `press`: a mouse-down, which must be on or near a page (START_PAGE_REACH_PX) and level with a line or within
   * START_REACH_PT of one. A drag's end has no such limits: it is always on the nearest page that has its glyphs read.
   */
  private endAt(x: number, y: number, o: { press?: boolean; column?: TextLine | null } = {}): End | null {
    const near = this.pagesNear(x, y);
    const hit = near[0];
    if (!hit || (o.press && hit.distance > START_PAGE_REACH_PX)) return null;
    // A press on a page whose glyphs are not read yet is on that page, not on the nearest one that has them.
    if (o.press && hit.distance > 0 && this.pageElementAt(x, y)) return null;
    const { s, g, rect } = hit;
    const p = this.toPage(s, rect, x, y);
    const on = this.glyphAt(g, p);
    if (on) return { pageIndex: s.index, start: on.start, end: on.end };

    const lines = this.linesOf(g);
    if (lines.length === 0) return null;
    const geo = lines.map((l) => {
      const pu = frame({ x: p.x, y: p.y, width: 0, height: 0 }, l.angle).u0;
      const pv = frame({ x: p.x, y: p.y, width: 0, height: 0 }, l.angle).v0;
      return { l, pu, du: Math.max(l.u0 - pu, 0, pu - l.u1), dv: Math.max(l.v0 - pv, 0, pv - l.v1) };
    });
    type Geo = (typeof geo)[number];
    const col = o.column ?? null;
    const sameColumn = (l: TextLine) => col === null || (Math.abs(l.angle - col.angle) < 0.5 && Math.min(l.u1, col.u1) - Math.max(l.u0, col.u0) > 0);
    // Over another column's text (along it): that column is meant, not the one the drag began in.
    const overOther = col !== null && geo.some((a) => !sameColumn(a.l) && a.du === 0) && !geo.some((a) => sameColumn(a.l) && a.du === 0);
    const prefer = (pool: Geo[]) => {
      const own = overOther ? [] : pool.filter((a) => sameColumn(a.l));
      return own.length > 0 ? own : pool;
    };
    const level = geo.filter((a) => a.dv === 0);
    const chosen =
      level.length > 0 ? prefer(level).reduce((a, b) => (b.du < a.du ? b : a)) : prefer(geo).reduce((a, b) => (Math.hypot(b.du, b.dv) < Math.hypot(a.du, a.dv) ? b : a));
    const { l: line, pu, du, dv } = chosen;
    if (o.press) {
      // In the margins beside the text (along the lines, outside all of them) only the distance across counts.
      const along = geo.filter((a) => Math.abs(a.l.angle - line.angle) < 0.5);
      const inMargin = along.every((a) => a.du > 0) && (along.every((a) => a.pu < a.l.u0) || along.every((a) => a.pu > a.l.u1));
      if ((inMargin ? dv : Math.hypot(du, dv)) > START_REACH_PT) return null;
    }
    const firstAlong = line.along[0];
    const lastAlong = line.along[line.along.length - 1];
    const first = line.units[0];
    const last = line.units[line.units.length - 1];
    const pastEnd = line.forward ? pu > lastAlong[1] : pu < lastAlong[0];
    const beforeStart = line.forward ? pu < firstAlong[0] : pu > firstAlong[1];
    if (pastEnd) return { pageIndex: s.index, start: last.start, end: last.end, caret: 'after' };
    if (beforeStart) return { pageIndex: s.index, start: first.start, end: first.end, caret: 'before' };
    let best = 0;
    let bestD = Infinity;
    line.along.forEach(([a, b], k) => {
      const dd = Math.max(a - pu, 0, pu - b);
      if (dd < bestD) {
        best = k;
        bestD = dd;
      }
    });
    const u = line.units[best];
    return { pageIndex: s.index, start: u.start, end: u.end };
  }

  /** A mounted page whose box holds the client point, glyphs read or not. */
  private pageElementAt(x: number, y: number): PageState | null {
    for (const s of this.pages.values()) {
      const r = s.host.closest<HTMLElement>('[data-page-index]')?.getBoundingClientRect();
      if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return s;
    }
    return null;
  }

  /** The position an end gives, for a selection running forward (from its anchor towards the document's end) or not. */
  private posOf(e: End, asFocus: boolean, forward: boolean): CharPos {
    if (e.caret) return { pageIndex: e.pageIndex, charIndex: e.caret === 'before' ? e.start : e.end };
    // A glyph is inside the selection: the anchor glyph starts it, the focus glyph ends it (R27).
    const at = forward === asFocus ? e.end : e.start;
    return { pageIndex: e.pageIndex, charIndex: at };
  }

  /** The selection from a drag's start to an end. It runs forward when the end is not before the start. */
  private selectionTo(from: End | CharPos, to: End): TextSelection {
    const where = (e: End): CharPos => (e.caret ? this.posOf(e, true, true) : { pageIndex: e.pageIndex, charIndex: e.start });
    if (isPos(from)) {
      const forward = cmpPos(where(to), from) >= 0;
      return { anchor: from, focus: this.posOf(to, true, forward) };
    }
    const forward = cmpPos(where(to), where(from)) >= 0;
    return { anchor: this.posOf(from, false, forward), focus: this.posOf(to, true, forward) };
  }

  /** The column a drag started in: the line of its start. */
  private columnOf(from: End | CharPos): TextLine | null {
    return isPos(from) ? this.lineOfChar(from.pageIndex, from.charIndex) : this.lineOfChar(from.pageIndex, from.start);
  }

  private onMouseDown(e: MouseEvent): void {
    this.endDrag();
    if (e.button !== 0 || e.altKey || !this.onPages(e)) return;
    const root = this.root!;
    const at = this.at(e);
    if (e.detail >= 2) {
      // The browser's own word and line selection stop at span edges; select PDFium's word or line instead.
      e.preventDefault();
      const hit = this.hitChar(at.x, at.y, true);
      const g = hit && this.glyphCache.get(hit.pageIndex);
      const r = hit && g && (e.detail === 2 ? wordAt(g, hit.charIndex) : lineAt(g, hit.charIndex));
      if (hit && r) this.setModel({ anchor: { pageIndex: hit.pageIndex, charIndex: r.start }, focus: { pageIndex: hit.pageIndex, charIndex: r.end } });
      return;
    }
    // The viewer makes the selection itself: the browser's would start from wherever the press lands in the layer (the
    // end of the page, for a press in a margin). The focus goes to the pages, as a press there would give it.
    e.preventDefault();
    // (Without its focus ring: a press is not keyboard use.)
    if (!root.contains(document.activeElement) || isEditable(document.activeElement)) root.focus({ preventScroll: true, focusVisible: false });
    const caretAt = this.caret.anchor();
    if (e.shiftKey && (this.model || caretAt || this.clickedAt)) {
      // Shift+press extends the selection (or, after a plain click, selects from the click or the caret), and goes on as
      // a drag.
      this.drag = { from: this.model?.anchor ?? caretAt ?? this.clickedAt, x0: at.x, y0: at.y, x: at.x, y: at.y, moved: true };
      this.updateDrag();
      return;
    }
    this.drag = { from: this.endAt(at.x, at.y, { press: true }), x0: at.x, y0: at.y, x: at.x, y: at.y, moved: false };
    // A press lets go of the old selection, as in Chrome's viewer; a drag makes the new one.
    this.setModel(null);
  }

  private onMouseMove(e: MouseEvent): void {
    const d = this.drag;
    if (!d) return;
    if ((e.buttons & 1) === 0) {
      this.endDrag();
      return;
    }
    const at = this.at(e);
    d.x = at.x;
    d.y = at.y;
    if (!d.moved && Math.hypot(d.x - d.x0, d.y - d.y0) >= DRAG_MIN_PX) d.moved = true;
    if (!d.moved) return;
    this.updateDrag();
    this.autoscroll();
  }

  private onMouseUp(e: MouseEvent): void {
    const d = this.drag;
    if (!d || e.button !== 0) return;
    const at = this.at(e);
    d.x = at.x;
    d.y = at.y;
    if (d.moved) this.updateDrag();
    this.endDrag();
    // A click, not a drag: with caret browsing on, the caret goes there.
    if (!d.moved) this.caret.click(at.x, at.y);
  }

  /** The selection as the drag now makes it (live, without the DOM, which endDrag sets). */
  private updateDrag(): void {
    const d = this.drag;
    if (!d?.moved || !d.from) return;
    const to = this.endAt(d.x, d.y, { column: this.columnOf(d.from) });
    // The page under the pointer may not have its glyphs yet (a drag that scrolls): read them, then follow again.
    this.loadUnder(d.x, d.y);
    if (!to) return;
    const next = this.selectionTo(d.from, to);
    this.model = cmpPos(next.anchor, next.focus) !== 0 ? next : null;
    this.schedulePaint();
  }

  /** Ends a drag: the DOM selection now shows the model, and Copy starts reading what it needs. */
  private endDrag(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.clickedAt = d.moved ? null : d.from && !isPos(d.from) ? d.from : null;
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = 0;
    this.setModel(this.model);
  }

  /** Reads the glyphs of a mounted page under (or nearest to) a client point that has none yet, and then follows the drag. */
  private loadUnder(x: number, y: number): void {
    let best: { s: PageState; d: number } | null = null;
    for (const s of this.pages.values()) {
      const el = s.host.closest<HTMLElement>('[data-page-index]');
      if (!el || this.glyphCache.has(s.index) || this.glyphLoads.has(s.index)) continue;
      const r = el.getBoundingClientRect();
      const d = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
      if (d === 0 && (!best || d < best.d)) best = { s, d };
    }
    if (!best) return;
    void this.queueGlyphs(best.s.index).then(
      () => {
        if (this.drag) this.updateDrag();
      },
      () => {},
    );
  }

  /** While a drag's pointer is at or past an edge of the page area, scrolls towards it every frame (as the browser does). */
  private autoscroll(): void {
    if (this.scrollFrame) return;
    const step = () => {
      this.scrollFrame = 0;
      const d = this.drag;
      const el = this.root;
      if (!d?.moved || !el) return;
      const r = el.getBoundingClientRect();
      const top = r.top + el.clientTop;
      const left = r.left + el.clientLeft;
      const bottom = top + el.clientHeight;
      const right = left + el.clientWidth;
      const speed = (over: number) => Math.min(AUTOSCROLL_MAX_PX, Math.max(AUTOSCROLL_MIN_PX, over * AUTOSCROLL_GAIN));
      const dy = d.y < top + AUTOSCROLL_EDGE_PX ? -speed(top + AUTOSCROLL_EDGE_PX - d.y) : d.y > bottom - AUTOSCROLL_EDGE_PX ? speed(d.y - (bottom - AUTOSCROLL_EDGE_PX)) : 0;
      const dx = d.x < left + AUTOSCROLL_EDGE_PX ? -speed(left + AUTOSCROLL_EDGE_PX - d.x) : d.x > right - AUTOSCROLL_EDGE_PX ? speed(d.x - (right - AUTOSCROLL_EDGE_PX)) : 0;
      const before = [el.scrollLeft, el.scrollTop];
      if (dy !== 0) el.scrollTop += dy;
      if (dx !== 0) el.scrollLeft += dx;
      if (el.scrollLeft === before[0] && el.scrollTop === before[1]) return;
      // The pages moved under the pointer.
      this.updateDrag();
      this.scrollFrame = requestAnimationFrame(step);
    };
    this.scrollFrame = requestAnimationFrame(step);
  }

  // ---- keys and Copy ----

  /**
   * Ctrl+A in the pages (or anywhere but a field or a dialog) selects the whole document, as in Chrome's viewer. The
   * moving keys are caret browsing's (R93): with Shift they move the selection's end, from the model, in PDFium's reading
   * order (the browser's own Shift+arrows stop at every span edge); Esc lets go of the selection.
   */
  private onKeyDown(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    const t = e.target instanceof Element ? e.target : document.activeElement;
    if (isEditable(t) || isEditable(document.activeElement)) return;
    if (t?.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
    if (this.caret.onKey(e) || e.altKey) return;
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || (e.key !== 'a' && e.key !== 'A' && e.code !== 'KeyA')) return;
    e.preventDefault();
    this.selectAll();
  }

  /** A field gives the focus back to anything but another field: the selection it held off (syncFromDom) is shown again. */
  private onFocusOut(e: FocusEvent): void {
    if (!this.model || !isEditable(e.target instanceof Element ? e.target : null)) return;
    if (isEditable(e.relatedTarget instanceof Element ? e.relatedTarget : null)) return;
    this.applyModel(true);
  }

  /**
   * Copy writes the model's text: each page's text model (PDFium's text with its joined line breaks, R26), pages joined by
   * a line break. Not when a field has the focus, or something else is selected (a note's text): the browser copies that.
   * Pages not on screen are read from the engine; when they are not all read yet, the clipboard is emptied at once (so a
   * paste never gives the old text), and filled when they are, with a note.
   */
  private onCopy(e: ClipboardEvent): void {
    const root = this.root;
    const m = this.model;
    if (e.defaultPrevented || !e.clipboardData || !root) return;
    if (isEditable(e.target instanceof Element ? e.target : null) || isEditable(document.activeElement)) return;
    const sel = document.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed && getSelectionRanges(root).length === 0) return;
    if (!m) {
      // Nothing is selected anywhere: the browser copies nothing and the clipboard keeps what it had. Say so, so that a
      // paste of that old text is never a surprise.
      if (!sel || sel.isCollapsed) this.o.onNote?.(NOTHING_TO_COPY);
      return;
    }
    e.preventDefault();
    const text = this.copyText(m);
    e.clipboardData.setData('text/plain', text ?? '');
    if (text === null) void this.copyLater(m);
  }

  /** Copies `m` once Copy has read its pages, through the async clipboard. */
  private async copyLater(m: TextSelection): Promise<void> {
    const [lo, hi] = this.ordered(m);
    const pages = hi.pageIndex - lo.pageIndex + 1;
    const note = this.o.onNote;
    note?.(pages > 1 ? `Copying ${pages} pages…` : 'Copying…');
    try {
      await this.readForCopy(m);
      const text = this.copyText(m);
      if (text === null) throw new Error('the pages could not be read');
      await navigator.clipboard.writeText(text);
      note?.('Copied');
    } catch (err) {
      console.error('sickofpdfs: the selection could not be copied', err);
      note?.('Couldn’t copy. Try again.');
    }
  }

  /** The pages of `m` and how much of each it covers: whole pages, or a part that is cut from the page's text model. */
  private copyParts(m: TextSelection): { pageIndex: number; whole: boolean; start: number; end: number }[] {
    const [lo, hi] = this.ordered(m);
    const out: { pageIndex: number; whole: boolean; start: number; end: number }[] = [];
    for (let p = lo.pageIndex; p <= hi.pageIndex; p++) {
      const n = this.countOf(p);
      const start = p === lo.pageIndex ? lo.charIndex : 0;
      const end = p === hi.pageIndex ? hi.charIndex : PAGE_END;
      const whole = start <= 0 && (end === PAGE_END || (n !== undefined && end >= n));
      out.push({ pageIndex: p, whole, start, end });
    }
    return out;
  }

  /**
   * The text Copy writes for `m`, or null while a page it needs is not read yet. With `maxChars`, only that much is
   * wanted: the text is cut there, and a page not read yet after some text ends it instead of giving null.
   */
  private copyText(m: TextSelection, maxChars = Infinity): string | null {
    const parts: string[] = [];
    let length = 0;
    for (const c of this.copyParts(m)) {
      if (length >= maxChars) break;
      const g = this.glyphCache.get(c.pageIndex);
      let t: string | undefined;
      if (c.whole) {
        t = this.pageTexts.get(c.pageIndex);
        if (t === undefined && g) this.pageTexts.set(c.pageIndex, (t = trimPageText(textModelSlice(textModel(g), 0, g.glyphs.length))));
      } else {
        const chars = (g ? textModel(g) : undefined) ?? this.endModels.get(c.pageIndex);
        if (chars) {
          t = textModelSlice(chars, c.start, Math.min(c.end, chars.length));
          if (c.start <= 0) t = t.replace(/^\s+/, '');
          if (c.end >= chars.length) t = t.replace(/\s+$/, '');
        }
      }
      if (t === undefined) {
        if (maxChars === Infinity || parts.length === 0) return null;
        break;
      }
      if (t !== '') {
        parts.push(t);
        length += t.length + 2;
      }
    }
    const text = parts.join('\r\n');
    return maxChars === Infinity ? text : text.slice(0, maxChars);
  }

  /** Reads, one page at a time, what Copy needs for `m` and does not have; stops early when `while` turns false. */
  private async readForCopy(m: TextSelection, still: () => boolean = () => true): Promise<void> {
    for (const c of this.copyParts(m)) {
      if (!still()) return;
      const p = c.pageIndex;
      const g = this.glyphCache.get(p);
      if (c.whole) {
        if (this.pageTexts.has(p)) continue;
        if (g) {
          this.pageTexts.set(p, trimPageText(textModelSlice(textModel(g), 0, g.glyphs.length)));
          continue;
        }
      } else if (g) {
        this.endModels.set(p, textModel(g));
        continue;
      } else if (this.endModels.has(p)) {
        continue;
      }
      let load = this.textLoads.get(p);
      if (!load) {
        const src = this.o.source;
        load = (
          c.whole && src.copyText
            ? src.copyText(p).then((r) => {
                this.pageTexts.set(p, r.text);
                this.charCounts.set(p, r.charCount);
              })
            : this.glyphs(p).then((gl) => {
                if (c.whole) this.pageTexts.set(p, trimPageText(textModelSlice(textModel(gl), 0, gl.glyphs.length)));
                else this.endModels.set(p, textModel(gl));
              })
        ).finally(() => this.textLoads.delete(p));
        this.textLoads.set(p, load);
      }
      await load;
    }
  }

  /** After the selection changes: keeps the text model of the pages it ends on part-way, and reads what Copy needs. */
  private prepareCopy(): void {
    const m = this.model;
    for (const p of [...this.endModels.keys()]) {
      if (!m || !this.copyParts(m).some((c) => c.pageIndex === p && !c.whole)) this.endModels.delete(p);
    }
    if (!m || this.drag) return;
    void this.readForCopy(m, () => this.model === m).catch((err: unknown) => {
      if (!(err instanceof PdfEngineCrashedError)) console.error('sickofpdfs: a page could not be read for Copy', err);
    });
  }
}

export interface TextLayerProps {
  controller: TextLayerController;
  box: PageBox;
  ctx: PageLayerContext;
}

/**
 * One page's text layer and selection overlay, for PageList's `renderPage` slot. The overlay is one SVG path under the
 * text layer; the layer itself is built by the controller.
 */
export const TextLayer = memo(function TextLayer({ controller, box, ctx }: TextLayerProps) {
  const host = useRef<HTMLDivElement>(null);
  const path = useRef<SVGPathElement>(null);
  const caret = useRef<HTMLDivElement>(null);
  const page = useRef<PageTextLayer | null>(null);
  const index = box.index;

  useLayoutEffect(() => {
    const p = controller.mount(index, host.current!, path.current!, caret.current);
    page.current = p;
    return () => {
      p.dispose();
      if (page.current === p) page.current = null;
    };
  }, [controller, index]);

  useLayoutEffect(() => {
    page.current?.setView(box, ctx);
  }, [box, ctx, controller, index]);

  return (
    <>
      <svg className="sop-selection" aria-hidden="true">
        <path ref={path} />
      </svg>
      <div ref={host} className="sop-text-layer-host" />
      <div ref={caret} className="sop-caret" hidden aria-hidden="true" />
    </>
  );
});
