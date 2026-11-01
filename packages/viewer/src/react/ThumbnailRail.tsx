// The thumbnails of the navigation rail (Task 24), as in Drive's viewer (02 section 4.10): one per page, 73 px wide,
// with its page number to the left; the page in view has a 2 px blue ring. A click shows that page.
//
// Thumbnails are the page list's own previews: the tab's one RenderScheduler draws them and keeps them in its preview
// cache, so a preview either of them asks for serves both, and there is no second engine. They are idle work
// (requestIdlePreview): they wait until the page list has nothing to draw. Only thumbnails within a screen of the
// rail's view are drawn; the others are let go, so a 600-page book holds a few dozen small canvases.
import { type JSX, type KeyboardEvent, memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PageSize, Rotation } from '../backend/types';
import { displayedSize } from '../layout/zoom';
import type { RenderScheduler } from '../render/scheduler';
import styles from './ThumbnailRail.module.css';
import { useViewerState, type ViewerStore } from './viewer-state';

export interface ThumbnailRailProps {
  scheduler: RenderScheduler;
  pages: PageSize[];
  store: ViewerStore;
  /** Shows page `i` (0-based). The rail does not touch history. */
  onSelect(this: void, i: number): void;
}

/**
 * A thumbnail whose preview was cancelled under it (the page list took the job over, then dropped it) asks again, up to
 * MAX_TRIES times, RETRY_MS apart.
 */
const MAX_TRIES = 3;
const RETRY_MS = 100;

interface Thumb {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  /** Within the observer's margin of the rail's view. */
  near: boolean;
  /** The rotation the canvas was drawn at, or null when it is empty. */
  drawn: Rotation | null;
  pending: AbortController | null;
  tries: number;
}

/** Draws the thumbnails near the rail's view and lets the others go. Lives outside React: no render per bitmap. */
class ThumbnailDrawer {
  private readonly thumbs = new Map<number, Thumb>();
  private observer: IntersectionObserver | null = null;
  private rotation: Rotation = 0;

  constructor(
    private readonly scheduler: RenderScheduler,
    private readonly pages: PageSize[],
  ) {}

  /** Starts watching which thumbnails are near the view of `root` (the rail's scroller). */
  connect(root: HTMLElement): void {
    this.observer?.disconnect();
    // One rail height above and below the view.
    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), { root, rootMargin: '100% 0px' });
    for (const t of this.thumbs.values()) this.observer.observe(t.el);
  }

  disconnect(): void {
    this.observer?.disconnect();
    this.observer = null;
    for (const t of this.thumbs.values()) {
      t.near = false;
      this.letGo(t);
    }
  }

  attach(index: number, el: HTMLElement, canvas: HTMLCanvasElement): void {
    this.thumbs.set(index, { el, canvas, near: false, drawn: null, pending: null, tries: 0 });
    this.observer?.observe(el);
  }

  detach(index: number, el: HTMLElement): void {
    const t = this.thumbs.get(index);
    if (!t || t.el !== el) return;
    this.observer?.unobserve(el);
    t.pending?.abort();
    this.thumbs.delete(index);
  }

  /** The view rotation changed: every thumbnail is drawn again. */
  setRotation(rotation: Rotation): void {
    if (rotation === this.rotation) return;
    this.rotation = rotation;
    for (const [i, t] of this.thumbs) {
      t.pending?.abort();
      t.pending = null;
      t.tries = 0;
      if (t.near) this.draw(i);
    }
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const i = Number((e.target as HTMLElement).dataset.thumbIndex);
      const t = this.thumbs.get(i);
      if (!t || t.el !== e.target) continue;
      t.near = e.isIntersecting;
      if (t.near) this.draw(i);
      else this.letGo(t);
    }
  }

  /** Cancels its preview and empties its canvas (the placeholder colour shows again). */
  private letGo(t: Thumb): void {
    t.pending?.abort();
    t.pending = null;
    t.tries = 0;
    if (t.drawn === null) return;
    t.canvas.width = 0;
    t.canvas.height = 0;
    t.drawn = null;
  }

  private draw(i: number): void {
    const t = this.thumbs.get(i);
    if (!t || !t.near || t.drawn === this.rotation || t.pending) return;
    const shown = displayedSize(this.pages[i], this.rotation);
    const fits = (b: ImageBitmap) => Math.abs(b.width / b.height - shown.width / shown.height) < 0.05;
    const cached = this.scheduler.cachedPreview(i);
    if (cached && fits(cached)) {
      this.paint(t, cached);
      return;
    }
    // The page list's own preview scale (PageDriver.previewScale), so both ask for, and cache, the same bitmap.
    const scale = this.scheduler.previewWidthPx / shown.width;
    const ac = new AbortController();
    t.pending = ac;
    this.scheduler.requestIdlePreview(i, scale, i, ac.signal).then(
      (bitmap) => {
        if (t.pending !== ac) return;
        t.pending = null;
        if (fits(bitmap)) this.paint(t, bitmap);
      },
      () => {
        if (t.pending !== ac) return;
        t.pending = null;
        if (ac.signal.aborted || t.tries >= MAX_TRIES) return;
        t.tries += 1;
        setTimeout(() => this.draw(i), RETRY_MS);
      },
    );
  }

  /** Draws a preview into the thumbnail at its size on screen. Preview bitmaps belong to the cache: never closed here. */
  private paint(t: Thumb, bitmap: ImageBitmap): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(t.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(t.canvas.clientHeight * dpr));
    t.canvas.width = w;
    t.canvas.height = h;
    const ctx = t.canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    t.drawn = this.rotation;
    t.tries = 0;
  }
}

/** Room left between a revealed thumbnail and the edge of the rail's view: its ring and a little more. */
const REVEAL_MARGIN_PX = 8;

/**
 * Puts the thumbnail of `index` inside the rail's view: centred when the rail opens or the page is far off (a jump),
 * otherwise only as far as needed (reading on, page by page).
 */
function reveal(nav: HTMLElement, index: number, opening: boolean): void {
  const el = nav.querySelector<HTMLElement>(`[data-thumb-index="${index}"]`);
  if (!el) return;
  const r = el.getBoundingClientRect();
  const view = nav.getBoundingClientRect();
  const pad = REVEAL_MARGIN_PX;
  const centre = opening || r.bottom < view.top || r.top > view.bottom;
  if (centre) nav.scrollTop += r.top + r.height / 2 - (view.top + view.height / 2);
  else if (r.top < view.top + pad) nav.scrollTop -= view.top + pad - r.top;
  else if (r.bottom > view.bottom - pad) nav.scrollTop += r.bottom - (view.bottom - pad);
}

/** The rail's thumbnail list: `<nav aria-label="Thumbnails">`. */
export function ThumbnailRail({ scheduler, pages, store, onSelect }: ThumbnailRailProps): JSX.Element {
  const current = useViewerState(store, (s) => s.currentPage);
  const rotation = useViewerState(store, (s) => s.viewRotation);
  const nav = useRef<HTMLElement>(null);
  const [drawer] = useState(() => new ThumbnailDrawer(scheduler, pages));
  // The keyboard's place in the list (one tab stop; the arrows move it). It follows the page in view.
  const [keys, setKeys] = useState({ index: current, current });
  if (keys.current !== current) setKeys({ index: current, current });
  const focusIndex = keys.current === current ? keys.index : current;
  const opened = useRef(false);

  useLayoutEffect(() => {
    drawer.connect(nav.current!);
    return () => drawer.disconnect();
  }, [drawer]);
  // After the page list's layout effects, so the scheduler has the new rotation (and an emptied cache) by then.
  useEffect(() => drawer.setRotation(rotation), [drawer, rotation]);

  useLayoutEffect(() => {
    if (nav.current) reveal(nav.current, current, !opened.current);
    opened.current = true;
  }, [current]);

  const onKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    const step: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity, PageDown: 5, PageUp: -5 };
    const d = step[e.key];
    if (d === undefined || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    const next = Math.min(pages.length - 1, Math.max(0, focusIndex + d));
    setKeys({ index: next, current });
    nav.current?.querySelector<HTMLElement>(`[data-thumb-index="${next}"]`)?.focus();
  };

  return (
    <nav ref={nav} aria-label="Thumbnails" className={styles.rail}>
      <ol className={styles.list} onKeyDown={onKeyDown}>
        {pages.map((page, i) => (
          <ThumbnailItem
            key={i}
            index={i}
            page={page}
            rotation={rotation}
            current={i === current}
            tabbable={i === focusIndex}
            drawer={drawer}
            onSelect={onSelect}
          />
        ))}
      </ol>
    </nav>
  );
}

interface ThumbnailItemProps {
  index: number;
  page: PageSize;
  rotation: Rotation;
  current: boolean;
  tabbable: boolean;
  drawer: ThumbnailDrawer;
  onSelect: (i: number) => void;
}

const ThumbnailItem = memo(function ThumbnailItem({ index, page, rotation, current, tabbable, drawer, onSelect }: ThumbnailItemProps) {
  const button = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const el = button.current!;
    drawer.attach(index, el, canvas.current!);
    return () => drawer.detach(index, el);
  }, [drawer, index]);
  const shown = displayedSize(page, rotation);
  return (
    <li className={styles.item}>
      <span className={styles.number} aria-hidden="true">
        {index + 1}
      </span>
      <button
        ref={button}
        type="button"
        className={styles.thumb}
        data-thumb-index={index}
        aria-label={`Page ${index + 1}`}
        aria-current={current ? 'page' : undefined}
        tabIndex={tabbable ? 0 : -1}
        style={{ aspectRatio: `${shown.width} / ${shown.height}` }}
        // A click shows the page without taking the focus, so the reading keys keep moving the pages.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onSelect(index)}
      >
        <canvas ref={canvas} className={styles.canvas} aria-hidden="true" />
      </button>
    </li>
  );
});
