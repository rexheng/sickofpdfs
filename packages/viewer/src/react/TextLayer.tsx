// The text layer of each page and the selection the viewer paints over it (Task 22).
//
// - Each page gets a pdf.js-style text layer (../text-layer) fed with PDFium's glyphs: invisible spans the browser
//   selects, copies and reads aloud. It is built lazily: once the page has been in view and its full render is on
//   screen, and once scrolling has paused (reading a page's glyphs takes the one engine worker 20–140 ms, and a page
//   drawn late is worse than a layer built late). It is destroyed with the page, outside the overscan.
// - The browser's selection highlight is transparent. The viewer paints the selection itself (R44): the selected chars
//   (charRangeFromDomRange) → PDFium's line rectangles (getTextRangeRects) → one even band a line (markLineRects, the
//   same rects marks are drawn with, so a highlight lines up exactly with the selection it was made from) → one SVG
//   path a page, in one colour, under the text layer.
// - A drag selects whole glyphs from the one under the mouse-down point to the one under the pointer, live and on
//   release (R27). A double-click selects the word, a triple-click the line (R28). Copy writes the text model's text:
//   PDFium's text with the joined line breaks (items.ts), so it matches Chrome's viewer (R26).
import { memo, useLayoutEffect, useRef } from 'react';
import type { PageGlyphs, PageSize, PdfRect } from '../backend/types';
import { cssPerPoint, displayedToPage, pageToDisplayed } from '../layout/page-space';
import type { PageBox } from '../layout/page-layout';
import { PT_TO_CSS } from '../layout/zoom';
import { highlightPath, markLineRects, normToCss, pdfRectToNorm, type RectSource } from '../marks/geometry';
import { charAtPoint, charRangeFromDomRange, type CharRange, domPositionOfChar, getSelectionRanges, glyphSelection, type GlyphHit, rangeBetween, selectCharRanges } from '../text-layer/char-map';
import { buildTextItems, type GlyphUnit, glyphUnits, lineAt, textModelRange, wordAt } from '../text-layer/items';
import { loadTextLayerFont, measureTextLayerText, renderTextLayer, type TextLayerHandle } from '../text-layer/text-layer';
import '../text-layer/text-layer.css';
import type { PageLayerContext } from './PageView';

/** Where the text layer reads a page's glyphs and selection rects: PdfBackend, or PageTextProvider (which caches). */
export interface TextLayerSource {
  glyphs(pageIndex: number): Promise<PageGlyphs>;
  /** getTextRangeRects: PDFium's merged line rects for chars [start, start + count), in points. */
  rects(pageIndex: number, start: number, count: number): Promise<PdfRect[]>;
}

export interface TextLayerControllerOptions {
  source: TextLayerSource;
  /** The document's pages (OpenResult.pages). */
  pages: PageSize[];
  /** The bundled layer font, pdf/NotoSans-Regular.ttf. */
  fontUrl: string;
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
/** Selection rect requests a page may have with the engine at once (two, so a drag never waits for a whole round trip). */
const RECT_REQUESTS_IN_FLIGHT = 2;
/** A mouse-down that moves less than this is a click, not a drag. */
const DRAG_MIN_PX = 3;
/** Glyph arrays kept for pages no longer mounted (about 300 bytes a char). */
const GLYPH_PAGES_KEPT = 8;
/**
 * A drag whose pointer is on no char ends on the nearest char within this many points, as Chrome's viewer does (it asks
 * PDFium for the char at the point with a tolerance, FPDFText_GetCharIndexAtPos). The pointer drifting into a column
 * gutter then ends the selection on the line it is level with, and never in the other column unless it is nearer.
 */
const DRAG_END_TOLERANCE_PT = 20;

interface PageState {
  index: number;
  size: PageSize;
  host: HTMLElement;
  path: SVGPathElement;
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

interface Drag {
  from: GlyphHit;
  x0: number;
  y0: number;
  x: number;
  y: number;
  moved: boolean;
}

/** One per open document: the pages' text layers, the selection painting, glyph-wise drags, word clicks and Copy. */
export class TextLayerController {
  private readonly pages = new Map<number, PageState>();
  private readonly glyphCache = new Map<number, PageGlyphs>();
  private readonly glyphLoads = new Map<number, Promise<PageGlyphs>>();
  private readonly units = new WeakMap<PageGlyphs, GlyphUnit[]>();
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
  /** The pointer's last position, with the fraction of a pixel that pointer events keep and mouse events drop. */
  private pointer: { x: number; y: number } | null = null;

  constructor(private readonly o: TextLayerControllerOptions) {
    this.rectSource = {
      rects: (p, s, c) => o.source.rects(p, s, c),
      glyphs: (p) => this.glyphs(p),
    };
  }

  /** Registers a page's layer host and selection path (TextLayer does this). */
  mount(index: number, host: HTMLElement, path: SVGPathElement): PageTextLayer {
    const s: PageState = {
      index,
      size: this.o.pages[index],
      host,
      path,
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
    return {
      setView: (box, ctx) => {
        if (s.disposed) return;
        s.box = box;
        s.ctx = ctx;
        s.handle?.update(this.scaleOf(s), box.rotation);
        this.draw(s);
        void this.ensureBuilt(s);
      },
      dispose: () => {
        s.disposed = true;
        this.observer?.unobserve(host);
        s.handle?.destroy();
        s.handle = null;
        if (this.pages.get(index) === s) this.pages.delete(index);
        if (this.pages.size === 0) this.uninstall();
      },
    };
  }

  /** The chars the document's selection covers (CharRange per page). */
  selectionRanges(): CharRange[] {
    return this.root ? getSelectionRanges(this.root) : [];
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

  /**
   * The char under a client point, by PDFium's own char boxes (Chrome's viewer also hit-tests PDFium's boxes, R27), not
   * by the layer's DOM boxes, which may be up to half a pixel off: a press just inside a glyph's edge is on that glyph. With
   * `tolerancePt`, a point on no char takes the nearest char within that distance. A char the layer does not show as
   * selectable (PDFium's joined hyphen, a char with no text) counts only with `withHyphen`. Falls back to the DOM.
   */
  private hitChar(x: number, y: number, o: { withHyphen?: boolean; tolerancePt?: number } = {}): GlyphHit | null {
    const root = this.root;
    if (!root) return null;
    let near: { hit: GlyphHit; d: number } | null = null;
    for (const s of this.pages.values()) {
      const g = this.glyphCache.get(s.index);
      const pageEl = s.host.closest<HTMLElement>('[data-page-index]');
      if (!s.box || !s.handle || !g || !pageEl) continue;
      const r = pageEl.getBoundingClientRect();
      const k = this.scaleOf(s);
      const reach = (o.tolerancePt ?? 0) * k;
      if (!(k > 0) || x < r.left - reach || x > r.right + reach || y < r.top - reach || y > r.bottom + reach) continue;
      const p = displayedToPage((x - r.left) / k, (y - r.top) / k, s.box.rotation, s.size.width, s.size.height);
      let inside: { start: number; d: number } | null = null;
      for (const u of this.unitsOf(g)) {
        const b = u.box;
        if (!b || u.hidden || u.lineBreak || (u.hyphen && !o.withHyphen)) continue;
        const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.width));
        const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.height));
        if (dx === 0 && dy === 0) {
          // Overlapping boxes (kerning, italics): the one whose centre is nearest.
          const c = Math.hypot(p.x - (b.x + b.width / 2), p.y - (b.y + b.height / 2));
          if (!inside || c < inside.d) inside = { start: u.start, d: c };
        } else if (o.tolerancePt) {
          const d = Math.hypot(dx, dy);
          if (d <= o.tolerancePt && (!near || d < near.d)) near = { hit: { pageIndex: s.index, charIndex: u.start }, d };
        }
      }
      if (inside) return { pageIndex: s.index, charIndex: inside.start };
    }
    return charAtPoint(root, x, y, o.withHyphen) ?? near?.hit ?? null;
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

  dispose(): void {
    for (const s of [...this.pages.values()]) {
      s.disposed = true;
      s.handle?.destroy();
    }
    this.pages.clear();
    this.uninstall();
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
      // A selection on this page survives the rebuild.
      const kept = this.root && s.handle ? getSelectionRanges(this.root) : [];
      s.handle?.destroy();
      const turned = s.box.rotation % 180 !== 0;
      const box: PageBox = { ...s.box, width: (turned ? s.size.height : s.size.width) * scale, height: (turned ? s.size.width : s.size.height) * scale };
      s.handle = renderTextLayer(s.host, items, box, s.index);
      s.handle.update(k, s.box.rotation);
      s.builtScale = scale;
      if (this.root && kept.some((r) => r.pageIndex === s.index)) selectCharRanges(this.root, kept);
    } catch (err) {
      if (!s.disposed) console.error(`sickofpdfs: the text layer of page ${s.index + 1} could not be built`, err);
      return;
    } finally {
      s.building = false;
    }
    if (this.isReady(s)) {
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

  // ---- selection: painting ----

  private schedulePaint(): void {
    if (this.paintFrame) return;
    this.paintFrame = requestAnimationFrame(() => {
      this.paintFrame = 0;
      this.paint();
    });
  }

  /** The chars to paint: during a drag, the glyph-inclusive selection the release will make; otherwise the DOM's. */
  private paintedRanges(): CharRange[] {
    const root = this.root;
    if (!root) return [];
    const d = this.drag;
    if (d?.moved) {
      const sel = document.getSelection();
      const focus = sel?.focusNode ? { node: sel.focusNode, offset: sel.focusOffset } : null;
      const ends = glyphSelection(root, d.from, this.hitChar(d.x, d.y, { tolerancePt: DRAG_END_TOLERANCE_PT }), focus);
      if (ends) return charRangeFromDomRange(root, rangeBetween(ends.anchor, ends.focus));
    }
    return getSelectionRanges(root);
  }

  private paint(): void {
    const ranges = this.paintedRanges();
    for (const s of this.pages.values()) {
      const r = ranges.find((x) => x.pageIndex === s.index);
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
        if (!s.disposed) console.error('sickofpdfs: the selection could not be drawn', err);
      },
    );
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

  // ---- selection: mouse, keyboard, copy ----

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
    document.addEventListener('selectionchange', () => this.schedulePaint(), { signal });
    document.addEventListener('scroll', () => (this.lastScrollAt = performance.now()), { signal, capture: true, passive: true });
    const notePointer = (e: PointerEvent) => (this.pointer = { x: e.clientX, y: e.clientY });
    document.addEventListener('pointerdown', notePointer, { signal, capture: true, passive: true });
    document.addEventListener('pointermove', notePointer, { signal, capture: true, passive: true });
    document.addEventListener('pointerup', notePointer, { signal, capture: true, passive: true });
    document.addEventListener('mousedown', (e) => this.onMouseDown(e), { signal, capture: true });
    document.addEventListener('mousemove', (e) => this.onMouseMove(e), { signal, passive: true });
    document.addEventListener('mouseup', (e) => this.onMouseUp(e), { signal });
    window.addEventListener('blur', () => (this.drag = null), { signal });
    document.addEventListener('copy', (e) => this.onCopy(e), { signal });
  }

  private uninstall(): void {
    this.listeners?.abort();
    this.listeners = null;
    this.observer?.disconnect();
    this.observer = null;
    if (this.paintFrame) cancelAnimationFrame(this.paintFrame);
    this.paintFrame = 0;
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

  private onMouseDown(e: MouseEvent): void {
    this.drag = null;
    const root = this.root;
    if (!root || e.button !== 0 || !(e.target instanceof Node) || !root.contains(e.target)) return;
    const at = this.at(e);
    const hit = this.hitChar(at.x, at.y, { withHyphen: e.detail >= 2 });
    if (!hit) return;
    if (e.detail >= 2) {
      // The browser's own word and line selection stop at span edges; select PDFium's word or line instead.
      const g = this.glyphCache.get(hit.pageIndex);
      const r = g && (e.detail === 2 ? wordAt(g, hit.charIndex) : lineAt(g, hit.charIndex));
      if (!r) return;
      e.preventDefault();
      selectCharRanges(root, [{ pageIndex: hit.pageIndex, ...r }]);
      this.schedulePaint();
      return;
    }
    if (!e.shiftKey) this.drag = { from: hit, x0: at.x, y0: at.y, x: at.x, y: at.y, moved: false };
  }

  private onMouseMove(e: MouseEvent): void {
    const d = this.drag;
    if (!d) return;
    if ((e.buttons & 1) === 0) {
      this.drag = null;
      return;
    }
    const at = this.at(e);
    d.x = at.x;
    d.y = at.y;
    if (!d.moved && Math.hypot(d.x - d.x0, d.y - d.y0) >= DRAG_MIN_PX) d.moved = true;
    if (d.moved) this.schedulePaint();
  }

  /** On release, the DOM selection is made glyph-inclusive, as painted during the drag. */
  private onMouseUp(e: MouseEvent): void {
    const d = this.drag;
    this.drag = null;
    const root = this.root;
    const at = this.at(e);
    if (!d || !root || e.button !== 0 || Math.hypot(at.x - d.x0, at.y - d.y0) < DRAG_MIN_PX) return;
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const focus = sel.isCollapsed || !sel.focusNode ? null : { node: sel.focusNode, offset: sel.focusOffset };
    const ends = glyphSelection(root, d.from, this.hitChar(at.x, at.y, { tolerancePt: DRAG_END_TOLERANCE_PT }), focus);
    if (ends) sel.setBaseAndExtent(ends.anchor.node, ends.anchor.offset, ends.focus.node, ends.focus.offset);
    this.schedulePaint();
  }

  /** Copy writes the text model's text of the selected chars (PDFium's text, R26), pages joined by a line break. */
  private onCopy(e: ClipboardEvent): void {
    const ranges = this.selectionRanges();
    if (ranges.length === 0 || !e.clipboardData) return;
    const parts: string[] = [];
    for (const r of ranges) {
      const g = this.glyphCache.get(r.pageIndex);
      if (g) parts.push(textModelRange(g, r.start, r.end));
    }
    e.clipboardData.setData('text/plain', parts.join('\r\n'));
    e.preventDefault();
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
  const page = useRef<PageTextLayer | null>(null);
  const index = box.index;

  useLayoutEffect(() => {
    const p = controller.mount(index, host.current!, path.current!);
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
    </>
  );
});
