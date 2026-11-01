// What the page list does every frame, outside React: which pages are on screen, which renders they need and in what
// order, painting the results, and the speed marks (sop:blank:<i>, sop:first-page). PageList owns one per document;
// PageView registers its DOM here (a PageSlot), so painting never waits for a React render.
//
// Render order, most urgent first (Phase 0, P0-3):
//   1. a preview of each visible page that has nothing on screen, in scroll order;
//   2. during a continuous scroll (not after a jump), or once step 3 is done: previews of the next LOOKAHEAD pages in
//      the scroll direction;
//   3. a full render of each visible page (above TILE_LIMIT device px a side: a capped base render plus TILE px tiles
//      of the part in view only);
//   4. when the scroll has been still for SCROLL_IDLE_MS: previews of the visible pages and, while full renders are
//      cheap (SPECULATIVE_FULL_MS), full renders of the pages just outside the view;
//   5. then, one at a time, previews of the nearest pages not cached yet, up to the cache's size. PDFium cannot stop a
//      render it has started, and with one engine worker a jump that lands while a full render is drawing waits for
//      it (about 200 ms on a 200 dpi scan, where tiling does not help: every tile decodes the whole JPEG again). With
//      the preview already cached, the page shows at once (R24).
// The scheduler puts every preview before any full render, so the queue only ever holds what is wanted right now.
import type { PageSize, Rotation } from '../backend/types';
import type { PageBox, PageLayout } from '../layout/page-layout';
import { visibleRange } from '../layout/page-layout';
import { displayedRectToPage } from '../layout/page-space';
import { displayedSize, pageDeviceSize } from '../layout/zoom';
import type { RenderScheduler } from '../render/scheduler';

/** The DOM of one mounted page (PageView). */
export interface PageSlot {
  index: number;
  /** The page box; holds the placeholder colour. */
  root: HTMLDivElement;
  /** The full render, drawn by a `bitmaprenderer` context (no main-thread copy, P0-3). */
  full: HTMLCanvasElement;
  /** The preview, stretched to the box until the full render arrives. */
  preview: HTMLCanvasElement;
  /** Tile canvases for very large zooms. */
  tiles: HTMLDivElement;
}

/** What the page list shows now. */
export interface DriverView {
  layout: PageLayout;
  scale: number;
  dpr: number;
  viewRotation: Rotation;
}

export interface DriverHooks {
  /** The pages to mount changed (visible pages plus OVERSCAN on each side). `fromEvent`: called from a DOM event. */
  onRange(range: { first: number; last: number }, fromEvent: boolean): void;
  /** The page with the most area in view changed. */
  onCurrentPage(index: number): void;
  /** A render failed for a reason other than being cancelled (an engine crash). */
  onError(err: unknown): void;
}

/** Pages mounted beyond the visible ones, on each side. */
export const OVERSCAN = 1;
/** Previews fetched ahead in the scroll direction. */
const LOOKAHEAD = 10;
/** Full renders above this many device px a side are tiled. */
const TILE_LIMIT = 4096;
const TILE = 1024;
/** The base render under the tiles is at most this many device px a side. */
const BASE_LIMIT = 2048;
/** Tiles are kept and fetched this far (CSS px) outside the viewport. */
const TILE_MARGIN = 256;
/** "Scrolling" means a scroll in the last SCROLL_IDLE_MS. */
const SCROLL_IDLE_MS = 200;
/** A scroll step shorter than this many viewport heights is part of a continuous scroll; a longer one is a jump. */
const CONTINUOUS_SCREENS = 2;
/**
 * Full renders of pages outside the view (step 4) are skipped while a full render takes longer than this: on a 200 dpi
 * scan one takes about 250 ms, and a jump that lands meanwhile would wait for it.
 */
const SPECULATIVE_FULL_MS = 120;

interface SlotState {
  slot: PageSlot;
  fullCtx: ImageBitmapRenderingContext | null;
  /** What is on screen: nothing (the placeholder), the preview, or a full render (or base and tiles). */
  painted: 'none' | 'preview' | 'full';
  /** The generation of the full canvas's bitmap, and whether it is a capped base render. */
  fullGen: string | null;
  fullIsBase: boolean;
  tiles: Map<string, { canvas: HTMLCanvasElement; gen: string }>;
}

interface TilePlan {
  key: string;
  rect: { x: number; y: number; width: number; height: number };
  /** Device px within the page bitmap, for placing the tile. */
  dev: { x: number; y: number; w: number; h: number };
  distance: number;
}

interface FullPlan {
  scale: number;
  devW: number;
  devH: number;
  tiled: boolean;
  baseScale: number;
}

const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';
const inRange = (i: number, r: { first: number; last: number }) => i >= r.first && i <= r.last;
const sameRange = (a: { first: number; last: number }, b: { first: number; last: number }) => a.first === b.first && a.last === b.last;

export class PageDriver {
  private scroller: HTMLElement | null = null;
  private view: DriverView | null = null;
  private gen = '';
  private genAbort = new AbortController();
  private readonly slots = new Map<number, SlotState>();
  /** Request keys whose results are awaited, with the priority they were asked at. */
  private readonly pending = new Map<string, number>();
  private visible = { first: 0, last: -1 };
  private mounted = { first: 0, last: -1 };
  private current = -1;
  private lastTop = 0;
  private direction: 1 | -1 = 1;
  private lastScrollAt = -Infinity;
  /** The last scroll that moved less than CONTINUOUS_SCREENS viewports: a wheel, a drag, the arrow keys (not a jump). */
  private lastContinuousScrollAt = -Infinity;
  private holdFullUntil = 0;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private wakeAt = Infinity;
  /** Visible pages with nothing on screen yet: their sop:blank measure is still open. */
  private readonly blankOpen = new Set<number>();
  private firstPageMarked = false;
  /** The page whose preview is being fetched ahead (step 5); one at a time. */
  private prefetching: number | null = null;
  private readonly paintWaiters = new Map<number, (() => void)[]>();
  private disposed = false;
  private hooks: DriverHooks = { onRange: () => {}, onCurrentPage: () => {}, onError: () => {} };

  constructor(
    private readonly scheduler: RenderScheduler,
    private readonly pages: PageSize[],
    /** The page whose first full paint is `sop:first-page`: the page the document opens at. */
    private readonly firstPage: number,
  ) {}

  setHooks(hooks: DriverHooks): void {
    this.hooks = hooks;
  }

  setScroller(el: HTMLElement | null): void {
    this.scroller = el;
    if (el) this.lastTop = el.scrollTop;
  }

  /** A new layout, scale, DPR or rotation. Renders of an older generation are cancelled or, once drawn, replaced. */
  setView(view: DriverView): void {
    const rotationChanged = this.view !== null && this.view.viewRotation !== view.viewRotation;
    this.view = view;
    const gen = `${view.scale}|${view.dpr}|${view.viewRotation}`;
    if (gen !== this.gen) {
      this.gen = gen;
      this.genAbort.abort();
      this.genAbort = new AbortController();
      for (const key of [...this.pending.keys()]) if (!key.startsWith('preview|')) this.pending.delete(key);
    }
    this.scheduler.setViewRotation(view.viewRotation);
    if (rotationChanged) {
      // What is on screen is turned the wrong way: back to placeholders, measured as blank until repainted.
      for (const key of [...this.pending.keys()]) this.pending.delete(key);
      for (const s of this.slots.values()) this.clearSlot(s);
      if (this.firstPageMarked) for (let i = this.visible.first; i <= this.visible.last; i++) this.openBlank(i);
    }
    this.update(false);
  }

  /** Zooming by wheel or pinch: hold full renders until the gesture pauses for `ms`. */
  holdFullRenders(ms: number): void {
    this.holdFullUntil = performance.now() + ms;
  }

  attach(slot: PageSlot): void {
    const state: SlotState = {
      slot,
      fullCtx: slot.full.getContext('bitmaprenderer'),
      painted: 'none',
      fullGen: null,
      fullIsBase: false,
      tiles: new Map(),
    };
    this.slots.set(slot.index, state);
    const cached = this.scheduler.cachedPreview(slot.index);
    if (cached) this.paintPreview(slot.index, cached);
    this.update(false);
  }

  /** The page was unmounted. Its canvases go with its DOM; nothing is emptied here (that would only cost time). */
  detach(slot: PageSlot): void {
    if (this.slots.get(slot.index)?.slot === slot) this.slots.delete(slot.index);
  }

  /** The scroll position changed (a scroll event, or our own scrollTop write). */
  onScroll(fromEvent: boolean): void {
    const top = this.scroller?.scrollTop ?? 0;
    if (top !== this.lastTop) {
      const now = performance.now();
      if (Math.abs(top - this.lastTop) < CONTINUOUS_SCREENS * (this.scroller?.clientHeight ?? 0)) this.lastContinuousScrollAt = now;
      this.direction = top > this.lastTop ? 1 : -1;
      this.lastTop = top;
      this.lastScrollAt = now;
    }
    this.update(fromEvent);
  }

  /** Resolves once page `index` has its full render (at the current zoom) on screen. */
  whenPainted(index: number): Promise<void> {
    if (this.isComplete(index)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.paintWaiters.get(index) ?? [];
      list.push(resolve);
      this.paintWaiters.set(index, list);
    });
  }

  /** The visible range (no overscan). */
  visiblePages(): { first: number; last: number } {
    return { ...this.visible };
  }

  /** Undoes dispose() (React's StrictMode unmounts and mounts every component once in development). */
  resume(): void {
    if (!this.disposed) return;
    this.disposed = false;
    this.genAbort = new AbortController();
    this.pending.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.genAbort.abort();
    clearTimeout(this.wakeTimer);
  }

  /** The per-frame step: visibility and blank marks, the current page, mounting, and render requests. */
  update(fromEvent: boolean): void {
    const el = this.scroller;
    const view = this.view;
    if (this.disposed || !el || !view) return;
    const top = el.scrollTop;
    const height = el.clientHeight;
    const now = performance.now();

    const visible = visibleRange(view.layout, top, height, 0);
    if (this.firstPageMarked) {
      for (let i = visible.first; i <= visible.last; i++) if (!inRange(i, this.visible)) this.openBlank(i);
      for (let i = this.visible.first; i <= this.visible.last; i++) if (!inRange(i, visible)) this.closeBlank(i);
    }
    this.visible = visible;

    const current = this.mostVisible(visible, top, height);
    if (current !== this.current && current >= 0) {
      this.current = current;
      this.hooks.onCurrentPage(current);
    }

    const mounted = visibleRange(view.layout, top, height, OVERSCAN);
    if (!sameRange(mounted, this.mounted)) {
      this.mounted = mounted;
      this.hooks.onRange(mounted, fromEvent);
    }

    this.request(view, now);
  }

  // ---- requests ----

  private request(view: DriverView, now: number): void {
    const { first, last } = this.visible;
    if (last < first) return;
    const step = this.direction;
    const visibleOrder: number[] = [];
    for (let k = 0; k <= last - first; k++) visibleOrder.push(step > 0 ? first + k : last - k);
    const scrolling = now - this.lastScrollAt < SCROLL_IDLE_MS;
    // Previews ahead help a continuous scroll; after a jump they would only hold up the page landed on.
    const flowing = now - this.lastContinuousScrollAt < SCROLL_IDLE_MS;
    const holding = now < this.holdFullUntil;

    // 1. previews of visible pages with nothing on screen
    visibleOrder.forEach((i, k) => {
      const s = this.slots.get(i);
      // The page the document opens at goes straight to its full render: a preview first would only delay it.
      if (!this.firstPageMarked && i === this.firstPage) return;
      if (!s || s.painted === 'none') this.wantPreview(i, k);
    });

    // 3. full renders of visible pages
    let fullsDone = true;
    if (!holding) {
      visibleOrder.forEach((i, k) => {
        if (!this.wantFull(view, i, k * 100)) fullsDone = false;
      });
    } else {
      fullsDone = false;
      this.wake(this.holdFullUntil + 1);
    }

    // 2. previews ahead in the scroll direction (and the page just behind)
    let ahead = { first, last };
    if (flowing || fullsDone) {
      const n = this.pages.length;
      for (let j = 1; j <= LOOKAHEAD; j++) {
        const i = step > 0 ? last + j : first - j;
        if (i < 0 || i >= n) break;
        this.wantPreview(i, 100 + j);
        ahead = { first: Math.min(ahead.first, i), last: Math.max(ahead.last, i) };
      }
      const behind = step > 0 ? first - 1 : last + 1;
      if (behind >= 0 && behind < n) this.wantPreview(behind, 100 + LOOKAHEAD + 1);
    }

    // 4. once the scroll is still: previews of the visible pages for the cache (a later jump back is then instant), and
    //    full renders just outside the view
    if (fullsDone && !holding) {
      if (scrolling) this.wake(this.lastScrollAt + SCROLL_IDLE_MS + 1);
      else {
        visibleOrder.forEach((i, k) => this.wantPreview(i, 200 + k));
        let outsideDone = true;
        const speculate = this.scheduler.fullRenderMs < SPECULATIVE_FULL_MS;
        for (let i = this.mounted.first; i <= this.mounted.last && speculate; i++) {
          if (inRange(i, this.visible) || !this.slots.has(i) || this.plan(view, i).tiled) continue;
          if (!this.wantFull(view, i, 10_000 + Math.abs(i - first))) outsideDone = false;
        }
        if (outsideDone) this.prefetchNext();
      }
    }

    // Everything queued for other pages is dropped, the step-5 preview too: it is asked for again once all is still.
    this.scheduler.retain({ first: Math.min(this.mounted.first, ahead.first) - 1, last: Math.max(this.mounted.last, ahead.last) + 1 });
  }

  /** Step 5: the preview of the nearest page (to the current one) that is not cached, within half the cache size. */
  private prefetchNext(): void {
    if (this.prefetching !== null) return;
    const n = this.pages.length;
    const reach = Math.floor(this.scheduler.previewCapacity / 2);
    const from = Math.max(0, this.current);
    for (let d = 0; d <= reach; d++) {
      for (const i of d === 0 ? [from] : [from + d, from - d]) {
        if (i < 0 || i >= n || this.scheduler.cachedPreview(i) || this.pending.has(`preview|${i}`)) continue;
        this.prefetching = i;
        this.wantPreview(i, 300 + d, () => {
          if (this.prefetching === i) this.prefetching = null;
        });
        return;
      }
    }
  }

  private wantPreview(i: number, priority: number, settled?: () => void): void {
    if (this.scheduler.cachedPreview(i)) {
      const s = this.slots.get(i);
      if (s?.painted === 'none') this.paintPreview(i, this.scheduler.cachedPreview(i)!);
      return;
    }
    const key = `preview|${i}`;
    if (this.pending.get(key) === priority) return;
    const known = this.pending.has(key);
    this.pending.set(key, priority);
    const p = this.scheduler.request(i, 'preview', this.previewScale(i), priority);
    if (known) return;
    p.then(
      (bitmap) => {
        this.pending.delete(key);
        settled?.();
        this.paintPreview(i, bitmap);
        this.update(false);
      },
      (err: unknown) => {
        this.pending.delete(key);
        settled?.();
        if (!isAbort(err)) this.hooks.onError(err);
      },
    );
  }

  /** Asks for page i's full render (or base and tiles). Returns true when it is already complete. */
  private wantFull(view: DriverView, i: number, priority: number): boolean {
    const plan = this.plan(view, i);
    const s = this.slots.get(i);
    const gen = this.gen;
    let complete = true;
    if (!plan.tiled) {
      if (s?.fullGen === gen && !s.fullIsBase) return true;
      this.wantBitmap(`full|${i}|${gen}`, i, plan.scale, priority, undefined, (b) => this.paintFull(i, b, gen, false));
      return false;
    }
    const tiles = this.tilePlans(view, i, plan);
    tiles.forEach((t, k) => {
      if (s?.tiles.get(t.key)?.gen === gen) return;
      complete = false;
      this.wantBitmap(t.key, i, plan.scale, priority + k, t.rect, (b) => this.paintTile(i, t, b, gen, plan));
    });
    if (!(s?.fullGen === gen && s.fullIsBase)) {
      complete = false;
      this.wantBitmap(`base|${i}|${gen}`, i, plan.baseScale, priority + 50, undefined, (b) => this.paintFull(i, b, gen, true));
    }
    if (s) this.pruneTiles(s, new Set(tiles.map((t) => t.key)), gen);
    return complete;
  }

  private wantBitmap(key: string, i: number, scale: number, priority: number, rect: TilePlan['rect'] | undefined, paint: (b: ImageBitmap) => void): void {
    if (this.pending.get(key) === priority) return;
    const known = this.pending.has(key);
    this.pending.set(key, priority);
    const p = this.scheduler.request(i, 'full', scale, priority, rect, this.genAbort.signal);
    if (known) return;
    p.then(
      (bitmap) => {
        if (this.pending.get(key) === undefined || this.disposed) {
          bitmap.close();
          return;
        }
        this.pending.delete(key);
        paint(bitmap);
        this.update(false);
      },
      (err: unknown) => {
        this.pending.delete(key);
        if (!isAbort(err)) this.hooks.onError(err);
      },
    );
  }

  private previewScale(i: number): number {
    const view = this.view;
    const d = displayedSize(this.pages[i]!, view?.viewRotation ?? 0);
    return this.scheduler.previewWidthPx / d.width;
  }

  /** The full render's size and scale for page i at the current view. */
  private plan(view: DriverView, i: number): FullPlan {
    const { scale, width: devW, height: devH } = pageDeviceSize(this.pages[i]!, view.viewRotation, view.scale, view.dpr);
    const tiled = Math.max(devW, devH) > TILE_LIMIT;
    return { scale, devW, devH, tiled, baseScale: tiled ? (scale * BASE_LIMIT) / Math.max(devW, devH) : scale };
  }

  /** The tiles of page i that meet the viewport (plus TILE_MARGIN), nearest the viewport centre first. */
  private tilePlans(view: DriverView, i: number, plan: FullPlan): TilePlan[] {
    const el = this.scroller!;
    const box: PageBox = view.layout.boxes[i]!;
    const page = this.pages[i]!;
    const { dpr } = view;
    const vx0 = el.scrollLeft - TILE_MARGIN;
    const vy0 = el.scrollTop - TILE_MARGIN;
    const vx1 = el.scrollLeft + el.clientWidth + TILE_MARGIN;
    const vy1 = el.scrollTop + el.clientHeight + TILE_MARGIN;
    const x0 = Math.max(0, Math.floor((vx0 - box.left) * dpr));
    const y0 = Math.max(0, Math.floor((vy0 - box.top) * dpr));
    const x1 = Math.min(plan.devW, Math.ceil((vx1 - box.left) * dpr));
    const y1 = Math.min(plan.devH, Math.ceil((vy1 - box.top) * dpr));
    if (x1 <= x0 || y1 <= y0) return [];
    const cx = (el.scrollLeft + el.clientWidth / 2 - box.left) * dpr;
    const cy = (el.scrollTop + el.clientHeight / 2 - box.top) * dpr;
    const out: TilePlan[] = [];
    for (let ty = Math.floor(y0 / TILE); ty * TILE < y1; ty++) {
      for (let tx = Math.floor(x0 / TILE); tx * TILE < x1; tx++) {
        const dev = { x: tx * TILE, y: ty * TILE, w: Math.min(TILE, plan.devW - tx * TILE), h: Math.min(TILE, plan.devH - ty * TILE) };
        const shown = { x: dev.x / plan.scale, y: dev.y / plan.scale, width: dev.w / plan.scale, height: dev.h / plan.scale };
        out.push({
          key: `tile|${i}|${this.gen}|${tx}|${ty}`,
          rect: displayedRectToPage(shown, box.rotation, page.width, page.height),
          dev,
          distance: Math.hypot(dev.x + dev.w / 2 - cx, dev.y + dev.h / 2 - cy),
        });
      }
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  // ---- painting ----

  private paintPreview(i: number, bitmap: ImageBitmap): void {
    const s = this.slots.get(i);
    if (!s || s.painted !== 'none') return;
    const canvas = s.slot.preview;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    canvas.style.visibility = '';
    s.painted = 'preview';
    this.onPainted(i, false);
  }

  private paintFull(i: number, bitmap: ImageBitmap, gen: string, isBase: boolean): void {
    const s = this.slots.get(i);
    if (!s || !s.fullCtx || gen !== this.gen) {
      bitmap.close();
      return;
    }
    s.slot.full.width = bitmap.width;
    s.slot.full.height = bitmap.height;
    s.fullCtx.transferFromImageBitmap(bitmap);
    s.slot.full.style.visibility = '';
    s.fullGen = gen;
    s.fullIsBase = isBase;
    if (!isBase) this.removeTiles(s, () => true);
    s.slot.preview.style.visibility = 'hidden';
    s.painted = 'full';
    this.onPainted(i, true);
  }

  private paintTile(i: number, t: TilePlan, bitmap: ImageBitmap, gen: string, plan: FullPlan): void {
    const s = this.slots.get(i);
    if (!s || gen !== this.gen) {
      bitmap.close();
      return;
    }
    s.tiles.get(t.key)?.canvas.remove();
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.setAttribute('aria-hidden', 'true');
    const pct = (v: number, of: number) => `${(v / of) * 100}%`;
    Object.assign(canvas.style, {
      position: 'absolute',
      display: 'block',
      left: pct(t.dev.x, plan.devW),
      top: pct(t.dev.y, plan.devH),
      width: pct(t.dev.w, plan.devW),
      height: pct(t.dev.h, plan.devH),
    });
    canvas.getContext('bitmaprenderer')?.transferFromImageBitmap(bitmap);
    s.slot.tiles.append(canvas);
    s.tiles.set(t.key, { canvas, gen });
    this.removeTiles(s, (_key, tile) => tile.gen !== gen);
    s.slot.preview.style.visibility = 'hidden';
    s.painted = 'full';
    this.onPainted(i, true);
  }

  private pruneTiles(s: SlotState, wanted: Set<string>, gen: string): void {
    this.removeTiles(s, (key, tile) => tile.gen === gen && !wanted.has(key));
  }

  private removeTiles(s: SlotState, match: (key: string, tile: { canvas: HTMLCanvasElement; gen: string }) => boolean): void {
    for (const [key, tile] of [...s.tiles]) {
      if (!match(key, tile)) continue;
      tile.canvas.getContext('bitmaprenderer')?.transferFromImageBitmap(null);
      tile.canvas.remove();
      s.tiles.delete(key);
    }
  }

  /**
   * Back to the placeholder: the canvases are hidden, not emptied. (Emptying a bitmaprenderer canvas with
   * transferFromImageBitmap(null) costs tens of ms on the main thread; the next paint replaces the bitmap anyway.)
   */
  private clearSlot(s: SlotState): void {
    s.slot.full.style.visibility = 'hidden';
    s.slot.preview.style.visibility = 'hidden';
    this.removeTiles(s, () => true);
    s.painted = 'none';
    s.fullGen = null;
    s.fullIsBase = false;
  }

  private onPainted(i: number, full: boolean): void {
    if (this.blankOpen.has(i)) this.closeBlank(i);
    if (!full) return;
    if (!this.firstPageMarked && i === this.firstPage) {
      this.firstPageMarked = true;
      performance.mark('sop:first-page');
      // Blank times count from here: opening the document is the first-page budget, not a scroll.
      for (let v = this.visible.first; v <= this.visible.last; v++) this.openBlank(v);
    }
    if (this.isComplete(i)) {
      const waiters = this.paintWaiters.get(i);
      this.paintWaiters.delete(i);
      for (const w of waiters ?? []) w();
    }
  }

  /** Page i shows its full render at the current generation (for a tiled page: the base and the tiles in view). */
  private isComplete(i: number): boolean {
    const s = this.slots.get(i);
    const view = this.view;
    if (!s || !view || s.fullGen !== this.gen) return false;
    const plan = this.plan(view, i);
    if (!plan.tiled) return !s.fullIsBase;
    return this.tilePlans(view, i, plan).every((t) => s.tiles.get(t.key)?.gen === this.gen);
  }

  // ---- blank marks ----

  /** Page i came into view: a blank period starts, and ends at once if something is already drawn. */
  private openBlank(i: number): void {
    performance.mark(`sop:blank-start:${i}`);
    const s = this.slots.get(i);
    if (s && s.painted !== 'none') {
      this.measureBlank(i);
      return;
    }
    this.blankOpen.add(i);
  }

  /** The blank period ends: page i was drawn, or it left the view still blank. */
  private closeBlank(i: number): void {
    if (!this.blankOpen.delete(i)) return;
    this.measureBlank(i);
  }

  private measureBlank(i: number): void {
    const start = `sop:blank-start:${i}`;
    try {
      performance.measure(`sop:blank:${i}`, start);
    } catch {
      // the start mark was cleared: nothing to measure
    }
    performance.clearMarks(start);
  }

  private mostVisible(r: { first: number; last: number }, top: number, height: number): number {
    const boxes = this.view?.layout.boxes;
    if (!boxes || r.last < r.first) return -1;
    let best = r.first;
    let bestArea = -1;
    for (let i = r.first; i <= r.last; i++) {
      const b = boxes[i]!;
      const area = Math.max(0, Math.min(b.top + b.height, top + height) - Math.max(b.top, top)) * b.width;
      if (area > bestArea) {
        best = i;
        bestArea = area;
      }
    }
    return best;
  }

  /** Runs update() at `at` (performance.now() time), unless an earlier wake-up is already set. */
  private wake(at: number): void {
    if (at >= this.wakeAt && this.wakeTimer !== undefined) return;
    clearTimeout(this.wakeTimer);
    this.wakeAt = at;
    this.wakeTimer = setTimeout(
      () => {
        this.wakeTimer = undefined;
        this.wakeAt = Infinity;
        this.update(false);
      },
      Math.max(0, at - performance.now()),
    );
  }
}
