// The page list: one scroll container (role="document") holding the pages near the viewport, positioned absolutely.
// It owns the zoom maths (anchored under the pointer, or at the viewport centre for keys), Ctrl+wheel and pinch, and
// the scroll moves the viewer's keys call. Rendering and painting go through a PageDriver (page-driver.ts) and the
// tab's one RenderScheduler.
import { type JSX, type ReactNode, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { OpenResult, PageSize, PdfBackend, Rotation } from '../backend/types';
import { computeLayout, type PageBox, type PageLayout, visibleRange } from '../layout/page-layout';
import { contentPointToPage, pagePointToContent, type PagePoint } from '../layout/page-space';
import { PAGE_GAP, pageDeviceSize, resolveScale, rowsOf, type Spread, stepZoom, wheelZoom, type ZoomMode } from '../layout/zoom';
import type { RenderScheduler } from '../render/scheduler';
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
  /** ArrowUp / ArrowDown: 40 px a line. */
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
}

/** Arrow keys scroll this far (Chromium's viewer). */
const LINE_PX = 40;
/** After the last Ctrl+wheel or pinch event, full renders wait this long, so a gesture renders once. */
const WHEEL_SETTLE_MS = 150;
/** How often devicePixelRatio is checked, besides the media query's change event. */
const DPR_CHECK_MS = 100;

interface Viewport {
  width: number;
  height: number;
}

interface Anchor {
  pageIndex: number;
  point: { x: number; y: number };
  /** The anchor's offset from the scroller's top-left, in CSS px. */
  dx: number;
  dy: number;
}

function scaleFor(zoom: ZoomMode, viewport: Viewport, pages: PageSize[], fitPage: number, viewRotation: Rotation, spread: Spread): number {
  if (zoom.kind !== 'fit-page') return resolveScale(zoom, viewport, pages, { viewRotation, spread });
  const rows = rowsOf(pages.length, spread);
  const row = rows.find((r) => r.includes(fitPage)) ?? rows[0] ?? [];
  return resolveScale(zoom, viewport, row.map((i) => pages[i]), { viewRotation, spread });
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
export function PageList({ doc, store, scheduler, renderPage, apiRef, onError }: PageListProps): JSX.Element {
  const pages = doc.open.pages;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const zoom = useViewerState(store, (s) => s.zoom);
  const viewRotation = useViewerState(store, (s) => s.viewRotation);
  const spread = useViewerState(store, (s) => s.spread);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  const [range, setRange] = useState({ first: 0, last: -1 });
  const [driver] = useState(() => new PageDriver(scheduler, pages, store.get().currentPage));
  const fitPage = useRef(store.get().currentPage);
  const pendingAnchor = useRef<Anchor | null>(null);
  const opened = useRef(false);
  const reportError = useRef(onError);
  useLayoutEffect(() => {
    reportError.current = onError;
  });

  const scale = viewport ? scaleFor(zoom, viewport, pages, fitPage.current, viewRotation, spread) : store.get().scale;
  const layout = useMemo(
    () => (viewport ? computeLayout(pages, { scale, viewRotation, spread, viewportWidth: viewport.width }) : null),
    [pages, scale, viewRotation, spread, viewport],
  );
  const latest = useRef({ layout, viewport, scale, viewRotation, spread, dpr });
  useLayoutEffect(() => {
    latest.current = { layout, viewport, scale, viewRotation, spread, dpr };
  });

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
  useLayoutEffect(() => {
    const el = scrollerRef.current!;
    const measure = () => {
      const next = { width: el.clientWidth, height: el.clientHeight };
      const prev = latest.current.viewport;
      if (prev && prev.width === next.width && prev.height === next.height) return;
      if (prev) {
        const rect = el.getBoundingClientRect();
        pendingAnchor.current = anchorAt({ clientX: rect.left + el.clientWidth / 2, clientY: rect.top });
      }
      latest.current = { ...latest.current, viewport: next };
      setViewport(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- anchorAt reads refs only
  }, []);

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
    if (a && layout.boxes[a.pageIndex]) {
      const c = pagePointToContent(layout.boxes[a.pageIndex], pages[a.pageIndex], a.point);
      el.scrollLeft = c.x - a.dx;
      el.scrollTop = c.y - a.dy;
    } else if (!opened.current) {
      const first = layout.boxes[store.get().currentPage];
      if (first) el.scrollTop = first.top - PAGE_GAP;
    }
    opened.current = true;
    if (store.get().scale !== scale) store.set({ scale });
    driver.setView({ layout, scale, dpr, viewRotation });
    driver.onScroll(false);
  }, [layout, dpr, scale, viewRotation, driver, pages, store]);

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
    const self: PageListApi = {
      zoomTo(mode, anchor) {
        const v = latest.current;
        if (mode.kind === 'fit-page') fitPage.current = store.get().currentPage;
        if (!v.viewport || !v.layout) {
          store.set({ zoom: mode });
          return;
        }
        const next = scaleFor(mode, v.viewport, pages, fitPage.current, v.viewRotation, v.spread);
        if (next !== v.scale) pendingAnchor.current = anchorAt(anchor);
        flushSync(() => store.set({ zoom: mode, scale: next }));
      },
      zoomStep(dir) {
        self.zoomTo({ kind: 'scale', scale: stepZoom(store.get().scale, dir) });
      },
      scrollLines(lines) {
        const s = el();
        if (!s) return;
        s.scrollTop += lines * LINE_PX;
        moved();
      },
      scrollScreens(dir) {
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
        const s = el();
        if (!s) return;
        s.scrollTop = 0;
        moved();
      },
      goToEnd() {
        const s = el();
        if (!s) return;
        s.scrollTop = s.scrollHeight;
        moved();
      },
      goToPage(index) {
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
    <div ref={scrollerRef} role="document" aria-label={doc.loaded.displayName} tabIndex={0} className={styles.scroller}>
      {layout && (
        <div className={styles.sizer} style={{ width: layout.width, height: Math.ceil(layout.height) }}>
          {mounted.map((i) => (
            <PageView key={i} box={layout.boxes[i]} device={deviceSizes[i]} dpr={dpr} driver={driver} renderPage={renderPage} />
          ))}
        </div>
      )}
    </div>
  );
}
