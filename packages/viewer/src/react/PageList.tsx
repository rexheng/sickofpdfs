// The page list: one scroll container (role="document") holding the pages near the viewport, positioned absolutely.
// It owns the zoom maths (anchored under the pointer, or at the viewport centre for keys), Ctrl+wheel and pinch, and
// the scroll moves the viewer's keys call. Rendering and painting go through a PageDriver (page-driver.ts) and the
// tab's one RenderScheduler.
// Task 26: it follows the store's view rotation and two-page view, keeping the passage at the centre of the view in
// view across a turn or a change of spread (R81), and its presentation mode (`presenting`): one page a screen on black,
// fit edge to edge, which the reading keys step through a page at a time.
import { type JSX, type ReactNode, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { OpenResult, PageSize, PdfBackend, Rotation } from '../backend/types';
import { computeLayout, type PageBox, type PageLayout, visibleRange } from '../layout/page-layout';
import { contentPointToPage, pagePointToContent, type PagePoint } from '../layout/page-space';
import { PAGE_GAP, pageDeviceSize, resolveScale, rowsOf, type Spread, stepZoom, wheelZoom, type ZoomMode } from '../layout/zoom';
import type { RenderScheduler } from '../render/scheduler';
import { presentationLayout, presentationScale, presentationTop } from '../view/view-state';
import { PageDriver } from './page-driver';
import styles from './PageList.module.css';
import { type PageLayerContext, PageView, snapToDevice } from './PageView';
import { useViewerState, type ViewerStore } from './viewer-state';

/** What the page list needs of an opened document (the extension's OpenedDocument has it). */
export interface PageListDocument {
  loaded: { displayName: string };
  open: OpenResult;
}

/** What the viewer's keys, toolbar and tests do with the page list. */
export interface PageListApi {
  /** Zooms, keeping the page point under `anchor` (client px) where it is; without one, the viewport centre. */
  zoomTo(mode: ZoomMode, anchor?: { clientX: number; clientY: number }): void;
  /** The next zoom preset in (1) or out (−1), around the viewport centre. */
  zoomStep(dir: 1 | -1): void;
  /** ArrowUp / ArrowDown: 40 px a line. In presentation mode each of these moves (and goToPage) is one page. */
  scrollLines(lines: number): void;
  /** PageUp / PageDown / Space: the viewport height less 40 px; one page in fit-page mode. */
  scrollScreens(dir: 1 | -1): void;
  /** ArrowLeft / ArrowRight: 40 px sideways when the pages are wider than the view, otherwise the previous or next page. */
  scrollSideways(dir: 1 | -1): void;
  /** Home / End. */
  goToStart(): void;
  goToEnd(): void;
  /** Scrolls page `index` to the top; resolves once its full render is on screen. */
  goToPage(index: number): Promise<void>;
  /**
   * Scrolls so the top of the view is `offset` of the way down page `index` (0 its top edge, 1 its bottom edge; below 0
   * is the gap above it) and, when `left` is given, the view's left edge is `left` CSS px right of the page's left edge.
   * For link destinations and Back (Task 24). Resolves once the page's full render is on screen.
   */
  scrollToOffset(index: number, offset: number, left?: number): Promise<void>;
  currentPage(): number;
  scrollTop(): number;
  maxScrollTop(): number;
  viewportHeight(): number;
  pageBoxes(): PageBox[];
  /** The page point under client point (x, y); null between pages. */
  pdfPointAt(x: number, y: number): PagePoint | null;
  /** Where a page point is now, in client px. */
  clientPointOf(p: PagePoint): { x: number; y: number };
  /**
   * Keeps `px` CSS px free at the right of the pages, beyond the usual PAGE_GAP, for the notes margin or the notes panel
   * (Phase 2). It never changes the zoom (ruling R69), except with `refit` (R98): fit modes still fit the whole width.
   * When the pages fit with that room beside them, they move left only as far as they must (a page that already has the
   * room stays where it is), and never further than `maxShift`. When they do not fit, they stay where they are; with
   * `scroll`, the scroll area grows by the room, so what lies under the notes panel can be scrolled into view. The page
   * point under `keep` (client px) stays where it is on screen; without one, the line at the top of the view does.
   */
  setReserveRight(px: number, keep?: { clientX: number; clientY: number }, o?: ReserveOptions): void;
  /** The width kept free at the right (setReserveRight). */
  reserveRight(): number;
  /**
   * Whether `px` CSS px (setReserveRight) fit at the right of the pages at the size they have now, moving them left no
   * further than `maxShift` from where they are without it.
   */
  roomForReserve(px: number, maxShift?: number): boolean;
  /**
   * The next re-layout that keeps the pages' size, if it comes within about 300 ms (a rail folding away, the reserve
   * changing), slides the pages from where they are on screen now to their new place over about 200 ms, so the eye
   * can follow them (R69). Nothing slides when the reader asked for reduced motion.
   */
  glide(): void;
  /**
   * A layer inside the scroll area, above the pages, that scrolls with them (the notes margin draws its cards here). Its
   * coordinates are the layout's: CSS px from the top-left of the scroll area, as pageBoxes() gives them. It ignores the
   * pointer itself; its children take it back. Null until the first layout.
   */
  overlayHost(): HTMLElement | null;
}

/** How the room at the right of the pages is kept (PageListApi.setReserveRight). */
export interface ReserveOptions {
  /** When the pages do not fit beside the room, the scroll area grows by it, so what lies under it can be scrolled to. */
  scroll?: boolean;
  /** The farthest the pages may move left for the room (R98: 120 px for the notes margin). Needing more, they stay put. */
  maxShift?: number;
  /**
   * In a fit zoom (fit width, fit page), the pages are fitted to the view less the room, so they sit beside it at a
   * smaller size instead of under it (R98: a slide beside the notes panel). Other zooms are never changed.
   */
  refit?: boolean;
}

export interface PageListProps {
  backend: PdfBackend;
  doc: PageListDocument;
  store: ViewerStore;
  scheduler: RenderScheduler;
  /** The text and link layers for a page (Task 22). */
  renderPage?: (box: PageBox, ctx: PageLayerContext) => ReactNode;
  /** Receives the page list's API while it is mounted. */
  apiRef?: RefObject<PageListApi | null>;
  /**
   * A page could not be drawn (not a cancelled render): called for each failed render, so the viewer can tell an
   * engine crash (PdfEngineCrashedError) from one bad page. Without it, each failure is logged.
   */
  onError?: (err: unknown) => void;
  /**
   * CSS px kept free at the right from the first layout (setReserveRight later changes it): a document that already has
   * notes opens with room for its notes margin, so its pages do not move once shown (R60).
   */
  initialReserveRight?: number;
  /** How the room kept at open is kept (its `maxShift`, as setReserveRight takes it). */
  initialReserveOptions?: ReserveOptions;
  /**
   * In two-page view, CSS px kept clear at each side of a fitted spread, so the spread is centred in the reading area and
   * the viewer's floating buttons at the edges (the rail's pill) never sit on a page.
   */
  spreadSideClearance?: number;
}

/** Arrow keys scroll this far (Chromium's viewer). */
const LINE_PX = 40;
/** After the last Ctrl+wheel or pinch event, full renders wait this long, so a gesture renders once. */
const WHEEL_SETTLE_MS = 150;
/** How often devicePixelRatio is checked, besides the media query's change event. */
const DPR_CHECK_MS = 100;
/** A glide (PageListApi.glide): how long the pages slide, and how long after the call a re-layout may still start one. */
const GLIDE_MS = 200;
const GLIDE_WINDOW_MS = 300;

interface Viewport {
  width: number;
  height: number;
  /** The scroll bar's width beside the view (the reading area is this much wider than the view). */
  gutter?: number;
}

interface Anchor {
  pageIndex: number;
  point: { x: number; y: number };
  /** The anchor's offset from the scroller's top-left, in CSS px. */
  dx: number;
  dy: number;
  /** A turn's or a spread change's anchor (R81): remembered for the next one (turnAnchor). */
  turn?: boolean;
  /** The view was at the very top: it stays there (the first page keeps its place under the toolbar). */
  top?: boolean;
}

/** The room kept at the right of the pages, and how (setReserveRight). */
interface Reserve {
  px: number;
  scroll: boolean;
  maxShift: number;
  refit: boolean;
}

function reserveOf(px: number, o: ReserveOptions | undefined): Reserve {
  return { px: Math.max(0, Math.round(px)), scroll: o?.scroll ?? false, maxShift: o?.maxShift ?? Infinity, refit: o?.refit ?? false };
}

const sameReserve = (a: Reserve, b: Reserve): boolean => a.px === b.px && a.scroll === b.scroll && a.maxShift === b.maxShift && a.refit === b.refit;

/**
 * The view a fit zoom fits the pages to: narrower by the room kept at the right when it asks to refit (R98), and by the
 * side clearance of a two-page spread. Other zooms see the whole view.
 */
function fitViewport(zoom: ZoomMode, viewport: Viewport, reserve: Reserve, spread: Spread, sideClearance: number): Viewport {
  if (zoom.kind === 'scale') return viewport;
  const less = (reserve.refit ? reserve.px : 0) + spreadClearance(viewport, spread, sideClearance).less;
  return less > 0 ? { width: Math.max(1, viewport.width - less), height: viewport.height } : viewport;
}

/**
 * A fitted two-page spread keeps `sideClearance` CSS px clear at each side of the reading area, the scroll bar counted
 * at the right, so it is centred in what the reader sees: `less` is how much narrower the view is for the fit, and
 * `shift` how far right the centred pages move.
 */
function spreadClearance(viewport: Viewport, spread: Spread, sideClearance: number): { less: number; shift: number } {
  if (spread !== 'two-page' || sideClearance <= 0) return { less: 0, shift: 0 };
  const bar = Math.min(viewport.gutter ?? 0, sideClearance);
  return { less: 2 * sideClearance - bar, shift: bar / 2 };
}

function scaleFor(zoom: ZoomMode, viewport: Viewport, pages: PageSize[], fitPage: number, viewRotation: Rotation, spread: Spread): number {
  if (zoom.kind !== 'fit-page') return resolveScale(zoom, viewport, pages, { viewRotation, spread });
  const rows = rowsOf(pages.length, spread);
  const row = rows.find((r) => r.includes(fitPage)) ?? rows[0] ?? [];
  return resolveScale(zoom, viewport, row.map((i) => pages[i]), { viewRotation, spread });
}

/** How far the pages of `l` must move left for `reserve` CSS px beside them (beyond PAGE_GAP), and whether they can. */
function reserveShift(l: PageLayout, viewportWidth: number, reserve: number, maxShift = Infinity): { shift: number; fits: boolean; right: number } {
  let left = Infinity;
  let right = 0;
  for (const b of l.boxes) {
    left = Math.min(left, b.left);
    right = Math.max(right, b.left + b.width);
  }
  const shift = right - (viewportWidth - PAGE_GAP - reserve);
  return { shift, right, fits: l.boxes.length > 0 && (shift <= 0 || (shift <= maxShift + 0.5 && left - shift >= PAGE_GAP - 0.5)) };
}

/**
 * The room kept at the right (setReserveRight), applied to a layout without changing its scale (R69). When the pages
 * fit with `reserve` CSS px beside them (beyond PAGE_GAP), moving no further than `maxShift`, every row moves left by
 * the same amount, only as far as the widest row needs. Otherwise nothing moves, and with `scroll` the scroll area
 * grows so the room can be scrolled to.
 */
function withReserve(l: PageLayout, viewportWidth: number, r: Reserve): PageLayout {
  if (r.px <= 0 || l.boxes.length === 0) return l;
  const { shift, right, fits } = reserveShift(l, viewportWidth, r.px, r.maxShift);
  if (shift <= 0) return l;
  if (fits) return { ...l, boxes: l.boxes.map((b) => ({ ...b, left: b.left - shift })) };
  return r.scroll ? { ...l, width: Math.max(l.width, right + PAGE_GAP + r.px) } : l;
}

/**
 * Two-page view: the second page of a pair starts exactly PAGE_GAP CSS px after the first as it is drawn (PageView
 * sizes a page to whole device pixels and puts it on one), so the pair is 16 px apart on screen, not 16 ± 1.
 */
function withSpreadGaps(l: PageLayout, pages: PageSize[], o: { viewRotation: Rotation; scale: number; dpr: number }): PageLayout {
  const boxes = l.boxes.map((b) => ({ ...b }));
  for (let i = 1; i < boxes.length; i++) {
    const before = boxes[i - 1];
    if (boxes[i].top !== before.top) continue;
    const drawnWidth = pageDeviceSize(pages[before.index], o.viewRotation, o.scale, o.dpr).width / o.dpr;
    boxes[i].left = snapToDevice(before.left, o.dpr) + drawnWidth + PAGE_GAP;
  }
  return { ...l, boxes };
}

/** The page whose box holds content point `c`, or the nearest one. */
function nearestPage(layout: PageLayout, c: { x: number; y: number }): number {
  const near = visibleRange(layout, c.y - 1, 2, 1);
  const candidates = near.last >= near.first ? near : { first: 0, last: layout.boxes.length - 1 };
  let best = candidates.first;
  let bestDistance = Infinity;
  for (let i = candidates.first; i <= candidates.last; i++) {
    const b = layout.boxes[i];
    const dx = Math.max(b.left - c.x, 0, c.x - (b.left + b.width));
    const dy = Math.max(b.top - c.y, 0, c.y - (b.top + b.height));
    const d = Math.hypot(dx, dy);
    if (d < bestDistance) {
      best = i;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * The document's pages, at the store's zoom and rotation. The zoom starts as the store's (fit width by default), and
 * the list opens at the store's currentPage.
 */
export function PageList({
  doc,
  store,
  scheduler,
  renderPage,
  apiRef,
  onError,
  initialReserveRight = 0,
  initialReserveOptions,
  spreadSideClearance = 0,
}: PageListProps): JSX.Element {
  const pages = doc.open.pages;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const zoom = useViewerState(store, (s) => s.zoom);
  const viewRotation = useViewerState(store, (s) => s.viewRotation);
  const spread = useViewerState(store, (s) => s.spread);
  const presenting = useViewerState(store, (s) => s.presenting);
  const presentingOn = presenting !== null;
  const [viewport, setViewport] = useState<Viewport | null>(null);
  // CSS px kept free at the right for the notes margin or panel; it moves the pages, never resizes them (setReserveRight).
  const [reserve, setReserve] = useState(() => reserveOf(initialReserveRight, initialReserveOptions));
  const sizerRef = useRef<HTMLDivElement>(null);
  /** A glide asked for (PageListApi.glide): where the page in view was on screen, until when, and at what scale. */
  const glideFrom = useRef<{ index: number; clientX: number; scale: number; until: number; base: number | null } | null>(null);
  const glideAnim = useRef<Animation | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  const [range, setRange] = useState({ first: 0, last: -1 });
  const [driver] = useState(() => new PageDriver(scheduler, pages, store.get().currentPage));
  const fitPage = useRef(store.get().currentPage);
  const pendingAnchor = useRef<Anchor | null>(null);
  /**
   * The last turn's anchor and the scroll position it left. The next turn keeps that same passage (not whatever a
   * sideways clamp left at the centre) while the reader has not moved the pages since, so turns in a row never drift.
   */
  const turnAnchor = useRef<{ anchor: Anchor; top: number; left: number } | null>(null);
  const opened = useRef(false);
  const reportError = useRef(onError);
  useLayoutEffect(() => {
    reportError.current = onError;
  });

  const scale = !viewport
    ? store.get().scale
    : presenting
      ? presentationScale(pages, presenting.page, viewport, viewRotation)
      : scaleFor(zoom, fitViewport(zoom, viewport, reserve, spread, spreadSideClearance), pages, fitPage.current, viewRotation, spread);
  const spreadLayout = (l: PageLayout) => (spread === 'two-page' ? withSpreadGaps(l, pages, { viewRotation, scale, dpr }) : l);
  /** The layout before the room at the right moves the pages (roomForReserve measures the move from it). */
  const base = useMemo(
    () => {
      if (!viewport || presentingOn) return null;
      const l = spreadLayout(computeLayout(pages, { scale, viewRotation, spread, viewportWidth: viewport.width }));
      // A fitted spread is centred in the whole reading area, the scroll bar's strip included (spreadClearance).
      const { shift } = zoom.kind === 'scale' ? { shift: 0 } : spreadClearance(viewport, spread, spreadSideClearance);
      return shift > 0 ? { ...l, boxes: l.boxes.map((b) => ({ ...b, left: b.left + shift })) } : l;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- spreadLayout reads spread, scale, viewRotation and dpr, listed here
    [pages, scale, viewRotation, spread, viewport, presentingOn, dpr, zoom.kind, spreadSideClearance],
  );
  const layout = useMemo(
    () => (!viewport ? null : presentingOn ? presentationLayout(pages, { scale, viewRotation, viewport }) : base && withReserve(base, viewport.width, reserve)),
    [pages, scale, viewRotation, viewport, reserve, presentingOn, base],
  );
  const latest = useRef({ layout, base, viewport, scale, viewRotation, spread, dpr, reserve, presenting: presentingOn, sideClearance: spreadSideClearance });
  useLayoutEffect(() => {
    latest.current = { layout, base, viewport, scale, viewRotation, spread, dpr, reserve, presenting: presentingOn, sideClearance: spreadSideClearance };
  });

  /** Where page `index` starts on screen, in client px, with the layout the page list has now (no glide counted). */
  const pageClientLeft = (index: number): number | null => {
    const el = scrollerRef.current;
    const b = latest.current.layout?.boxes[index];
    return el && b ? el.getBoundingClientRect().left - el.scrollLeft + b.left : null;
  };

  /** The page point at a client point (or at the viewport centre), to keep in place across a re-layout. */
  const anchorAt = (anchor?: { clientX: number; clientY: number }): Anchor | null => {
    const el = scrollerRef.current;
    const l = latest.current.layout;
    if (!el || !l || l.boxes.length === 0) return null;
    const rect = el.getBoundingClientRect();
    const dx = anchor ? anchor.clientX - rect.left : el.clientWidth / 2;
    const dy = anchor ? anchor.clientY - rect.top : el.clientHeight / 2;
    const c = { x: el.scrollLeft + dx, y: el.scrollTop + dy };
    const i = nearestPage(l, c);
    return { pageIndex: i, point: contentPointToPage(l.boxes[i], pages[i], c), dx, dy };
  };

  // R81: a turn or a change of spread keeps the passage at the centre of the view where it is. The store tells its
  // listeners before React draws the new layout, so the anchor is read from the layout on screen now.
  useLayoutEffect(
    () =>
      store.subscribe(() => {
        const s = store.get();
        const v = latest.current;
        if (s.presenting !== null || v.presenting || pendingAnchor.current) return; // presentation places its own page
        if (s.viewRotation === v.viewRotation && s.spread === v.spread) return;
        const el = scrollerRef.current;
        const kept = turnAnchor.current;
        const centre = el ? { dx: el.clientWidth / 2, dy: el.clientHeight / 2 } : null;
        const still = el !== null && kept !== null && centre !== null && el.scrollTop === kept.top && el.scrollLeft === kept.left;
        const a = still ? { ...kept.anchor, ...centre } : anchorAt();
        // At the very top of the document, the turned pages start at the top too: the first page stays below the toolbar.
        pendingAnchor.current = a && { ...a, turn: true, top: el !== null && el.scrollTop <= 0 };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- anchorAt reads refs only
    [store],
  );

  // The driver's callbacks and scroll container.
  useLayoutEffect(() => {
    driver.setHooks({
      onRange: (r, fromEvent) => (fromEvent ? flushSync(() => setRange(r)) : setRange(r)),
      onCurrentPage: (i) => store.set({ currentPage: i }),
      onError: (err) => (reportError.current ? reportError.current(err) : console.error('sickofpdfs: a page could not be drawn', err)),
    });
    driver.setScroller(scrollerRef.current);
    return () => driver.setScroller(null);
  }, [driver, store]);
  useEffect(() => {
    driver.resume();
    return () => driver.dispose();
  }, [driver]);

  // Viewport size (fit modes follow it); on a resize the line at the top of the view stays put.
  const measureNow = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const el = scrollerRef.current!;
    const measure = () => {
      const next = { width: el.clientWidth, height: el.clientHeight, gutter: Math.max(0, el.offsetWidth - el.clientWidth) };
      const prev = latest.current.viewport;
      if (prev && prev.width === next.width && prev.height === next.height && prev.gutter === next.gutter) return;
      if (prev) {
        const rect = el.getBoundingClientRect();
        pendingAnchor.current = anchorAt({ clientX: rect.left + el.clientWidth / 2, clientY: rect.top });
      }
      latest.current = { ...latest.current, viewport: next };
      setViewport(next);
    };
    measure();
    measureNow.current = measure;
    // The new size is laid out before the browser paints: a rail folding away must not show one frame of the pages
    // where the old layout puts them in the new, wider area.
    const observer = new ResizeObserver(() => flushSync(measure));
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- anchorAt reads refs only
  }, []);

  // Presentation mode starting or ending changes the page area's size at once (it covers the screen): measured in the same
  // frame, so leaving it lays the pages out at their old size straight away and the old place can be restored.
  useLayoutEffect(() => measureNow.current(), [presentingOn]);

  // Device pixel ratio: a change (another screen, browser zoom) re-renders the pages at the new resolution. Chrome
  // reports it through the resolution media query; a DPR emulated over DevTools changes devicePixelRatio without that
  // event, so a cheap check every DPR_CHECK_MS backs it up.
  useEffect(() => {
    let query: MediaQueryList | null = null;
    const check = () => {
      const now = window.devicePixelRatio || 1;
      setDpr((was) => (was === now ? was : now));
    };
    const onChange = () => {
      check();
      listen();
    };
    const listen = () => {
      query?.removeEventListener('change', onChange);
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      query.addEventListener('change', onChange);
    };
    listen();
    const timer = setInterval(check, DPR_CHECK_MS);
    return () => {
      query?.removeEventListener('change', onChange);
      clearInterval(timer);
    };
  }, []);

  // A new layout: keep the anchor in place (or open at the first page asked for), then tell the driver.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !layout) return;
    const a = pendingAnchor.current;
    pendingAnchor.current = null;
    if (presenting && viewport) {
      // Presentation mode: the page on screen fills the view; no other page is in it. A step past either end stays there.
      const page = Math.min(pages.length - 1, Math.max(0, presenting.page));
      if (page !== presenting.page) store.set({ presenting: { page } });
      el.scrollLeft = 0;
      el.scrollTop = presentationTop(layout.boxes[page], viewport.height);
    } else if (a && layout.boxes[a.pageIndex]) {
      const c = pagePointToContent(layout.boxes[a.pageIndex], pages[a.pageIndex], a.point);
      el.scrollLeft = c.x - a.dx;
      el.scrollTop = a.top === true ? 0 : c.y - a.dy;
      turnAnchor.current = a.turn ? { anchor: a, top: el.scrollTop, left: el.scrollLeft } : null;
    } else if (!opened.current) {
      const first = layout.boxes[store.get().currentPage];
      if (first) el.scrollTop = first.top - PAGE_GAP;
    }
    opened.current = true;
    if (store.get().scale !== scale) store.set({ scale });
    driver.setView({ layout, scale, dpr, viewRotation });
    driver.onScroll(false);
    // A glide asked for (R69): the pages slide from where they were on screen to their new place.
    const g = glideFrom.current;
    const sizer = sizerRef.current;
    if (presenting) glideFrom.current = null;
    if (!g || !sizer || presenting) return;
    if (performance.now() > g.until || g.scale !== scale) {
      glideFrom.current = null;
      return;
    }
    const base = pageClientLeft(g.index);
    if (base === null) return;
    // Where the pages show now: the start, or partway through a slide that an earlier re-layout began.
    const running = glideAnim.current;
    const shown = running && g.base !== null ? g.base + (parseFloat(getComputedStyle(sizer).translate) || 0) : g.clientX;
    running?.cancel();
    g.base = base;
    const dx = shown - base;
    if (Math.abs(dx) < 0.5 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // The slide must not add a sideways scroll bar for its 200 ms: the pages fit the view (nothing to scroll sideways).
    if (el.scrollWidth > el.clientWidth + 0.5) return;
    el.style.overflowX = 'hidden';
    const slide = sizer.animate([{ translate: `${dx}px 0` }, { translate: '0 0' }], { duration: GLIDE_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
    glideAnim.current = slide;
    const done = () => {
      if (glideAnim.current !== slide) return;
      glideAnim.current = null;
      el.style.overflowX = '';
    };
    slide.onfinish = done;
    slide.oncancel = done;
  }, [layout, dpr, scale, viewRotation, driver, pages, store, presenting, viewport]);

  const api = useMemo<PageListApi>(() => {
    const el = () => scrollerRef.current;
    // Where a page is drawn: PageView puts its box on whole device pixels, up to half a device pixel from the layout's.
    const drawn = (b: PageBox): PageBox => ({ ...b, left: snapToDevice(b.left, latest.current.dpr), top: snapToDevice(b.top, latest.current.dpr) });
    const moved = () => driver.onScroll(true);
    const neighbour = (dir: 1 | -1) => {
      const rows = rowsOf(pages.length, latest.current.spread);
      const at = rows.findIndex((r) => r.includes(store.get().currentPage));
      return rows[Math.min(rows.length - 1, Math.max(0, at + dir))]?.[0] ?? 0;
    };
    /** Presentation mode: shows page `index` (clamped); resolves once its full render is on screen. */
    const present = (index: number): Promise<void> | null => {
      const now = store.get().presenting;
      if (now === null || pages.length === 0) return null;
      const page = Math.min(pages.length - 1, Math.max(0, Math.round(index)));
      if (page !== now.page) flushSync(() => store.set({ presenting: { page } }));
      return driver.whenPainted(page);
    };
    const step = (dir: number) => present((store.get().presenting?.page ?? 0) + Math.sign(dir));
    const self: PageListApi = {
      zoomTo(mode, anchor) {
        const v = latest.current;
        if (store.get().presenting !== null) return; // presentation mode keeps its page fit to the screen
        if (mode.kind === 'fit-page') fitPage.current = store.get().currentPage;
        if (!v.viewport || !v.layout) {
          store.set({ zoom: mode });
          return;
        }
        const next = scaleFor(mode, fitViewport(mode, v.viewport, v.reserve, v.spread, v.sideClearance), pages, fitPage.current, v.viewRotation, v.spread);
        if (next !== v.scale) pendingAnchor.current = anchorAt(anchor);
        flushSync(() => store.set({ zoom: mode, scale: next }));
      },
      zoomStep(dir) {
        self.zoomTo({ kind: 'scale', scale: stepZoom(store.get().scale, dir) });
      },
      scrollLines(lines) {
        if (step(lines)) return;
        const s = el();
        if (!s) return;
        s.scrollTop += lines * LINE_PX;
        moved();
      },
      scrollScreens(dir) {
        if (step(dir)) return;
        const s = el();
        if (!s) return;
        if (store.get().zoom.kind === 'fit-page') {
          void self.goToPage(neighbour(dir));
          return;
        }
        s.scrollTop += dir * (s.clientHeight - LINE_PX);
        moved();
      },
      scrollSideways(dir) {
        if (step(dir)) return;
        const s = el();
        const l = latest.current.layout;
        if (!s || !l) return;
        if (l.width > s.clientWidth + 0.5) {
          s.scrollLeft += dir * LINE_PX;
          moved();
        } else {
          void self.goToPage(neighbour(dir));
        }
      },
      goToStart() {
        if (present(0)) return;
        const s = el();
        if (!s) return;
        s.scrollTop = 0;
        moved();
      },
      goToEnd() {
        if (present(pages.length - 1)) return;
        const s = el();
        if (!s) return;
        s.scrollTop = s.scrollHeight;
        moved();
      },
      goToPage(index) {
        const shown = present(index);
        if (shown) return shown;
        const s = el();
        const l = latest.current.layout;
        if (!s || !l || l.boxes.length === 0) return Promise.resolve();
        const i = Math.min(l.boxes.length - 1, Math.max(0, Math.round(index)));
        // Rounded up: scrollTop snaps to whole pixels, and rounding down would leave a sliver of the previous page in view.
        s.scrollTop = Math.ceil(l.boxes[i].top - PAGE_GAP);
        moved();
        return driver.whenPainted(i);
      },
      scrollToOffset(index, offset, left) {
        const shown = present(index);
        if (shown) return shown;
        const s = el();
        const l = latest.current.layout;
        if (!s || !l || l.boxes.length === 0) return Promise.resolve();
        const b = l.boxes[Math.min(l.boxes.length - 1, Math.max(0, Math.round(index)))];
        s.scrollTop = Math.round(b.top + offset * b.height);
        if (left !== undefined) s.scrollLeft = Math.round(b.left + left);
        moved();
        return driver.whenPainted(b.index);
      },
      currentPage: () => store.get().currentPage,
      scrollTop: () => el()?.scrollTop ?? 0,
      maxScrollTop: () => {
        const s = el();
        return s ? s.scrollHeight - s.clientHeight : 0;
      },
      viewportHeight: () => el()?.clientHeight ?? 0,
      pageBoxes: () => (latest.current.layout?.boxes ?? []).map((b) => ({ ...b })),
      pdfPointAt(x, y) {
        const s = el();
        const l = latest.current.layout;
        if (!s || !l) return null;
        const rect = s.getBoundingClientRect();
        const c = { x: x - rect.left + s.scrollLeft, y: y - rect.top + s.scrollTop };
        const i = nearestPage(l, c);
        const b = drawn(l.boxes[i]);
        if (c.x < b.left || c.x > b.left + b.width || c.y < b.top || c.y > b.top + b.height) return null;
        return { pageIndex: i, ...contentPointToPage(b, pages[i], c) };
      },
      clientPointOf(p) {
        const s = el();
        const l = latest.current.layout;
        const b = l?.boxes[p.pageIndex];
        if (!s || !b) return { x: NaN, y: NaN };
        const rect = s.getBoundingClientRect();
        const c = pagePointToContent(drawn(b), pages[p.pageIndex], p);
        return { x: c.x - s.scrollLeft + rect.left, y: c.y - s.scrollTop + rect.top };
      },
      setReserveRight(px, keep, o) {
        const next = reserveOf(px, o);
        if (sameReserve(next, latest.current.reserve)) return;
        const s = el();
        if (s && latest.current.layout) {
          const rect = s.getBoundingClientRect();
          pendingAnchor.current = anchorAt(keep ?? { clientX: rect.left + s.clientWidth / 2, clientY: rect.top });
        }
        latest.current = { ...latest.current, reserve: next };
        flushSync(() => setReserve(next));
      },
      reserveRight: () => latest.current.reserve.px,
      roomForReserve(px, maxShift = Infinity) {
        const v = latest.current;
        if (!v.viewport || !v.base) return false;
        return reserveShift(v.base, v.viewport.width, px, maxShift).fits;
      },
      glide() {
        const i = store.get().currentPage;
        const x = pageClientLeft(i);
        glideFrom.current = x === null ? null : { index: i, clientX: x, scale: latest.current.scale, until: performance.now() + GLIDE_WINDOW_MS, base: null };
      },
      overlayHost: () => overlayRef.current,
    };
    return self;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- anchorAt reads refs only
  }, [driver, pages, store]);

  useLayoutEffect(() => {
    if (!apiRef) return;
    apiRef.current = api;
    return () => {
      apiRef.current = null;
    };
  }, [api, apiRef]);

  // Ctrl+wheel and pinch (Chrome sends a pinch as wheel events with ctrlKey) zoom the pages, never the browser.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      driver.holdFullRenders(WHEEL_SETTLE_MS);
      api.zoomTo({ kind: 'scale', scale: wheelZoom(store.get().scale, e.deltaY, e.deltaMode) }, { clientX: e.clientX, clientY: e.clientY });
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [api, driver, store]);

  // Scroll events drive the driver; it mounts pages synchronously from here (flushSync), so they are never late.
  useEffect(() => {
    const el = scrollerRef.current!;
    const onScroll = () => driver.onScroll(true);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [driver]);

  const deviceSizes = useMemo(() => pages.map((p) => pageDeviceSize(p, viewRotation, scale, dpr)), [pages, viewRotation, scale, dpr]);
  const mounted: number[] = [];
  if (layout) for (let i = range.first; i <= Math.min(range.last, layout.boxes.length - 1); i++) mounted.push(i);
  return (
    <div
      ref={scrollerRef}
      role="document"
      aria-label={doc.loaded.displayName}
      tabIndex={0}
      className={presentingOn ? `${styles.scroller} ${styles.presenting}` : styles.scroller}
      data-presenting={presentingOn ? '' : undefined}
    >
      {layout && (
        <div ref={sizerRef} className={styles.sizer} style={{ width: layout.width, height: Math.ceil(layout.height) }}>
          {mounted.map((i) => (
            <PageView key={i} box={layout.boxes[i]} device={deviceSizes[i]} dpr={dpr} driver={driver} renderPage={renderPage} />
          ))}
          <div ref={overlayRef} className={styles.overlay} />
        </div>
      )}
    </div>
  );
}
