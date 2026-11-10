// The thumbnails of the navigation rail (Task 24), as in Drive's viewer (02 section 4.10): one per page, 73 px wide,
// with its page number to the left; the page in view has a 2 px blue ring. A click shows that page.
//
// R108: the thumbnails are in the order the reader put the pages in (the store's pageOrder), and moving them is how the
// order is made, as in Google Slides' filmstrip:
// - Drag a thumbnail to move its page. A line shows where it will land, and the list scrolls by itself near its top and
//   bottom edges. Escape while dragging puts it back.
// - Ctrl-click (or Cmd-click) adds a page to the selection or takes it out; Shift-click selects every page between the
//   last one clicked and this one. A drag of a selected page moves the whole selection, in the order shown.
// - With a thumbnail focused, Alt+Up and Alt+Down move it (or the selection it is in) one place. Escape clears the selection.
// - Right-click, Shift+F10 or the menu key asks for the rail's menu (onMenu: the viewer's "Move to start", "Reset page
//   order", ...).
// The page number beside each thumbnail is its place in that order. Moving pages re-lays the list out; nothing is drawn
// again (thumbnails are kept by page, and the canvases move with their elements).
//
// Thumbnails are the page list's own previews: the tab's one RenderScheduler draws them and keeps them in its preview
// cache, so a preview either of them asks for serves both, and there is no second engine. They are idle work
// (requestIdlePreview): they wait until the page list has nothing to draw. Only thumbnails within a screen of the
// rail's view are drawn; the others are let go, so a 600-page book holds a few dozen small canvases.
import { pageAtPosition, positionOfPage } from '@sop/core/page-order';
import {
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { PageSize, Rotation } from '../backend/types';
import { displayedSize } from '../layout/zoom';
import type { RenderScheduler } from '../render/scheduler';
import { isSideways, turnMatrix } from '../view/page-transform';
import styles from './ThumbnailRail.module.css';
import { useViewerState, type ViewerStore } from './viewer-state';

export interface ThumbnailRailProps {
  scheduler: RenderScheduler;
  pages: PageSize[];
  store: ViewerStore;
  /** Shows page `i` (0-based). The rail does not touch history. */
  onSelect(this: void, i: number): void;
  /**
   * R108: moves `pages` (original page indices, in the order shown) together to just before position `before` (0 the
   * start, the page count the end). Without it the thumbnails cannot be dragged or moved with Alt+Up and Alt+Down.
   */
  onMove?(this: void, pages: number[], before: number): void;
  /** R108: the rail's menu for `pages` (the selection, or the one page), at a point in the window. */
  onMenu?(this: void, pages: number[], at: { x: number; y: number }): void;
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
  private redraw = 0;

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

  /**
   * The view rotation changed: every thumbnail is drawn again, turned (from the cache: previews are upright). After the
   * next frame, so the pages show the turn first.
   */
  setRotation(rotation: Rotation): void {
    if (rotation === this.rotation) return;
    this.rotation = rotation;
    for (const t of this.thumbs.values()) {
      t.pending?.abort();
      t.pending = null;
      t.tries = 0;
    }
    cancelAnimationFrame(this.redraw);
    this.redraw = requestAnimationFrame(() => {
      this.redraw = 0;
      setTimeout(() => {
        for (const [i, t] of this.thumbs) if (t.near) this.draw(i);
      }, 0);
    });
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
    // Previews are upright (RenderScheduler): checked and asked for as the upright page, turned when painted.
    const upright = displayedSize(this.pages[i], 0);
    const fits = (b: ImageBitmap) => Math.abs(b.width / b.height - upright.width / upright.height) < 0.05;
    const cached = this.scheduler.cachedPreview(i);
    if (cached && fits(cached)) {
      this.paint(t, cached);
      return;
    }
    // The page list's own preview scale (PageDriver.previewScale), so both ask for, and cache, the same bitmap.
    const scale = this.scheduler.previewWidthPx / upright.width;
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

  /**
   * Draws a preview into the thumbnail at its size on screen, turned by the view's rotation (the page's one turn,
   * view/page-transform.ts). Preview bitmaps belong to the cache: never closed here.
   */
  private paint(t: Thumb, bitmap: ImageBitmap): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(t.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(t.canvas.clientHeight * dpr));
    t.canvas.width = w;
    t.canvas.height = h;
    const ctx = t.canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingQuality = 'high';
    const [uw, uh] = isSideways(this.rotation) ? [h, w] : [w, h];
    const m = turnMatrix(this.rotation, uw, uh);
    if (m) ctx.setTransform(...m);
    ctx.drawImage(bitmap, 0, 0, uw, uh);
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

/** The list is built this long after the rail mounts at the latest (sooner if the page is idle first). */
const LIST_IDLE_TIMEOUT_MS = 300;

/** A press that moves this far (CSS px) is a drag, not a click. */
const DRAG_START_PX = 5;
/** Near the rail's top or bottom edge (CSS px), a drag scrolls the list. */
const EDGE_PX = 48;
/** The fastest the list scrolls under a drag, CSS px a frame (at the very edge, or past it). */
const EDGE_SPEED_PX = 18;

interface Drag {
  /** The pages being moved, in the order shown. */
  pages: number[];
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  /** Past DRAG_START_PX: the drag is on (the ghost and the line show). */
  live: boolean;
  /** Where they would land: before this position. */
  before: number | null;
  ghost: HTMLElement | null;
  frame: number;
}

/** The thumbnail buttons, top to bottom (the DOM order is the order shown). */
function thumbButtons(nav: HTMLElement): HTMLElement[] {
  return [...nav.querySelectorAll<HTMLElement>('[data-thumb-index]')];
}

/** Where a drop at window y lands: before the first thumbnail whose middle is below y (binary search; they are in order). */
function dropPosition(buttons: readonly HTMLElement[], y: number): number {
  let lo = 0;
  let hi = buttons.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const r = buttons[mid].getBoundingClientRect();
    if (y < r.top + r.height / 2) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The floating copy of the dragged thumbnail that follows the pointer: the first page's picture, the others as a stack
 * behind it, and their count. Outside React, so it moves with the pointer without a render.
 */
function makeGhost(source: HTMLElement | null, count: number): HTMLElement {
  const ghost = document.createElement('div');
  ghost.className = styles.ghost;
  ghost.setAttribute('aria-hidden', 'true');
  const from = source?.querySelector('canvas');
  const r = source?.getBoundingClientRect();
  const w = r?.width ?? 73;
  const h = r?.height ?? 97;
  if (count > 1) {
    const stack = document.createElement('div');
    stack.className = styles.ghostStack;
    stack.style.width = `${w}px`;
    stack.style.height = `${h}px`;
    ghost.append(stack);
  }
  const card = document.createElement('div');
  card.className = styles.ghostCard;
  card.style.width = `${w}px`;
  card.style.height = `${h}px`;
  if (from instanceof HTMLCanvasElement && from.width > 0 && from.height > 0) {
    const copy = document.createElement('canvas');
    copy.width = from.width;
    copy.height = from.height;
    copy.getContext('2d')?.drawImage(from, 0, 0);
    card.append(copy);
  }
  ghost.append(card);
  if (count > 1) {
    const badge = document.createElement('span');
    badge.className = styles.ghostCount;
    badge.textContent = String(count);
    ghost.append(badge);
  }
  document.body.append(ghost);
  return ghost;
}

/** The rail's thumbnail list: `<nav aria-label="Thumbnails">`. */
export function ThumbnailRail({ scheduler, pages, store, onSelect, onMove, onMenu }: ThumbnailRailProps): JSX.Element {
  const rotation = useViewerState(store, (s) => s.viewRotation);
  const order = useViewerState(store, (s) => s.pageOrder);
  const nav = useRef<HTMLElement>(null);
  const line = useRef<HTMLDivElement>(null);
  const [drawer] = useState(() => new ThumbnailDrawer(scheduler, pages));
  // The list is built once the page list has asked for its first page: a 600-page list costs a frame.
  const [ready, setReady] = useState(false);
  // Where the arrow keys moved the focus; null: the page in view. Either way the list is one tab stop.
  const [keyIndex, setKeyIndex] = useState<number | null>(null);
  // R108: the pages picked with Ctrl- and Shift-click (original indices), and the page a Shift-click counts from.
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const anchor = useRef<number | null>(null);
  const [dragging, setDragging] = useState<ReadonlySet<number> | null>(null);
  const drag = useRef<Drag | null>(null);
  /** A drag just ended on this press: the click that follows is not a click. */
  const swallowClick = useRef(false);
  /** After a keyboard move, the moved thumbnail gets the focus back (its element moved in the list). */
  const refocus = useRef<number | null>(null);
  const shown = useMemo(() => order ?? pages.map((_, i) => i), [order, pages]);

  useLayoutEffect(() => {
    drawer.connect(nav.current!);
    return () => drawer.disconnect();
  }, [drawer]);
  // After the page list's layout effects, so the page list's turn is under way first (previews come from the cache).
  useEffect(() => drawer.setRotation(rotation), [drawer, rotation]);
  useEffect(() => {
    const idle = requestIdleCallback(() => setReady(true), { timeout: LIST_IDLE_TIMEOUT_MS });
    return () => cancelIdleCallback(idle);
  }, []);

  // Follows the page in view, without re-rendering the list: its thumbnail comes into view (centred when the rail
  // opens), and the keyboard's place goes back to it.
  useEffect(() => {
    if (!ready) return;
    let shownPage = -1;
    let opening = true;
    let frame = 0;
    const follow = () => {
      const page = store.get().currentPage;
      if (page === shownPage) return;
      shownPage = page;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (nav.current && drag.current?.live !== true) reveal(nav.current, page, opening);
        opening = false;
      });
    };
    follow();
    const unsubscribe = store.subscribe(() => {
      if (store.get().currentPage === shownPage) return;
      setKeyIndex(null);
      follow();
    });
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
    };
  }, [store, ready]);

  // A thumbnail moved with the keys keeps the focus, and stays in view.
  useLayoutEffect(() => {
    const page = refocus.current;
    if (page === null || !nav.current) return;
    refocus.current = null;
    const el = nav.current.querySelector<HTMLElement>(`[data-thumb-index="${page}"]`);
    el?.focus({ preventScroll: true });
    reveal(nav.current, page, false);
  }, [order]);

  /** The pages a move or the menu acts on from `page`: the selection when the page is in it, otherwise the page alone. */
  const pagesFrom = useCallback(
    (page: number): number[] => {
      if (!selected.has(page)) return [page];
      return [...selected].sort((a, b) => positionOfPage(order, a) - positionOfPage(order, b));
    },
    [selected, order],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    const focusedPage = Number((e.target as HTMLElement).dataset.thumbIndex);
    const onThumb = Number.isInteger(focusedPage);
    // R108: Alt+Up and Alt+Down move the focused page (or the selection it is in) one place.
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && onThumb && onMove) {
      e.preventDefault();
      e.stopPropagation();
      const moving = pagesFrom(focusedPage);
      const at = moving.map((p) => positionOfPage(order, p));
      const first = Math.min(...at);
      const last = Math.max(...at);
      const before = e.key === 'ArrowUp' ? first - 1 : last + 2;
      if (before < 0 || before > pages.length) return;
      refocus.current = focusedPage;
      setKeyIndex(focusedPage);
      onMove(moving, before);
      return;
    }
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      if (!onThumb || !onMenu) return;
      e.preventDefault();
      e.stopPropagation();
      const r = (e.target as HTMLElement).getBoundingClientRect();
      onMenu(pagesFrom(focusedPage), { x: r.right, y: r.top + r.height / 2 });
      return;
    }
    if (e.key === 'Escape' && selected.size > 0) {
      e.preventDefault();
      e.stopPropagation();
      setSelected(new Set());
      return;
    }
    const step: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity, PageDown: 5, PageUp: -5 };
    const d = step[e.key];
    if (d === undefined || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    // Through the pages as they are shown.
    const from = positionOfPage(order, keyIndex ?? store.get().currentPage);
    const next = pageAtPosition(order, Math.min(pages.length - 1, Math.max(0, from + d)));
    setKeyIndex(next);
    nav.current?.querySelector<HTMLElement>(`[data-thumb-index="${next}"]`)?.focus();
  };

  // ---- clicks: show the page, or pick pages (Ctrl, Shift) ----

  const onPick = useCallback(
    (page: number, e: ReactMouseEvent<HTMLButtonElement>) => {
      if (swallowClick.current) {
        swallowClick.current = false;
        return;
      }
      const toggle = e.ctrlKey || e.metaKey;
      if (onMove && (toggle || e.shiftKey)) {
        // Picking pages to move together; the page in view stays where it is.
        const from = anchor.current ?? store.get().currentPage;
        if (e.shiftKey) {
          const a = positionOfPage(order, from);
          const b = positionOfPage(order, page);
          const range = new Set<number>(toggle ? selected : []);
          for (let p = Math.min(a, b); p <= Math.max(a, b); p++) range.add(pageAtPosition(order, p));
          setSelected(range);
        } else {
          const next = new Set(selected);
          // The first Ctrl-click keeps the page last clicked in the selection, as a filmstrip does, while it is the page
          // in view (its ring shows it as picked); otherwise only what the reader clicks is picked.
          const last = anchor.current;
          if (next.size === 0 && last !== null && last !== page && last === store.get().currentPage) next.add(last);
          if (next.has(page)) next.delete(page);
          else next.add(page);
          setSelected(next);
          anchor.current = page;
        }
        return;
      }
      anchor.current = page;
      if (selected.size > 0) setSelected(new Set());
      onSelect(page);
    },
    [onMove, onSelect, order, selected, store],
  );

  const onContextMenu = useCallback(
    (page: number, e: ReactMouseEvent<HTMLButtonElement>) => {
      if (!onMenu) return;
      e.preventDefault();
      if (!selected.has(page) && selected.size > 0) setSelected(new Set());
      onMenu(pagesFrom(page), { x: e.clientX, y: e.clientY });
    },
    [onMenu, pagesFrom, selected],
  );

  // ---- dragging ----

  /** Shows the drop line before position `before`, or hides it (null). */
  const placeLine = (before: number | null) => {
    const el = line.current;
    const root = nav.current;
    if (!el || !root) return;
    const buttons = before === null ? [] : thumbButtons(root);
    if (before === null || buttons.length === 0) {
      el.hidden = true;
      return;
    }
    const view = root.getBoundingClientRect();
    const above = buttons[before - 1]?.getBoundingClientRect();
    const below = buttons[before]?.getBoundingClientRect();
    const y = above && below ? (above.bottom + below.top) / 2 : above ? above.bottom + 6 : below ? below.top - 6 : 0;
    el.hidden = false;
    el.style.top = `${y - view.top + root.scrollTop}px`;
  };

  /** Works out the drop place and scrolls near the edges: every frame while the drag is on. */
  const tick = () => {
    const d = drag.current;
    const root = nav.current;
    if (!d || !d.live || !root) return;
    const view = root.getBoundingClientRect();
    const speed = d.y < view.top + EDGE_PX ? -Math.min(1, (view.top + EDGE_PX - d.y) / EDGE_PX) : d.y > view.bottom - EDGE_PX ? Math.min(1, (d.y - (view.bottom - EDGE_PX)) / EDGE_PX) : 0;
    if (speed !== 0) root.scrollTop += Math.round(speed * EDGE_SPEED_PX) || Math.sign(speed);
    const before = dropPosition(thumbButtons(root), d.y);
    if (before !== d.before) d.before = before;
    placeLine(before);
    d.frame = requestAnimationFrame(tick);
  };

  const endDrag = (drop: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    cancelAnimationFrame(d.frame);
    d.ghost?.remove();
    placeLine(null);
    if (!d.live) return;
    swallowClick.current = true;
    // the click (if any) comes in the same task as pointerup; one that never comes must not swallow a later click
    setTimeout(() => (swallowClick.current = false), 0);
    setDragging(null);
    if (drop && d.before !== null && onMove) {
      anchor.current = d.pages[0];
      if (d.pages.length > 1) setSelected(new Set(d.pages));
      onMove(d.pages, d.before);
    }
  };

  const onPointerDown = (page: number, e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!onMove || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    drag.current = { pages: pagesFrom(page), pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, live: false, before: null, ghost: null, frame: 0 };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    d.x = e.clientX;
    d.y = e.clientY;
    if (!d.live) {
      if (Math.hypot(d.x - d.startX, d.y - d.startY) < DRAG_START_PX) return;
      d.live = true;
      nav.current?.setPointerCapture(e.pointerId);
      const first = nav.current?.querySelector<HTMLElement>(`[data-thumb-index="${d.pages[0]}"]`) ?? null;
      d.ghost = makeGhost(first, d.pages.length);
      setDragging(new Set(d.pages));
      // A page dragged from outside the picked ones moves alone: the others are let go, as in a filmstrip.
      if (!selected.has(d.pages[0]) && selected.size > 0) setSelected(new Set());
      d.frame = requestAnimationFrame(tick);
    }
    if (d.ghost) d.ghost.style.transform = `translate(${d.x + 12}px, ${d.y + 8}px)`;
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    endDrag(true);
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId === e.pointerId) endDrag(false);
  };

  // Escape while dragging puts the pages back where they were; so does losing the window.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || drag.current?.live !== true) return;
      e.preventDefault();
      e.stopPropagation();
      endDrag(false);
    };
    const onBlur = () => endDrag(false);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      endDrag(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- endDrag reads refs; a drag in progress ends with the rail
  }, []);

  // A selection of pages that are no longer there (another document) is let go.
  useEffect(() => setSelected(new Set()), [pages]);

  return (
    <nav
      ref={nav}
      aria-label="Thumbnails"
      className={styles.rail}
      data-dragging={dragging !== null ? '' : undefined}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <ol className={styles.list} onKeyDown={onKeyDown} data-sideways={isSideways(rotation) ? '' : undefined}>
        {ready &&
          shown.map((i, position) => (
            <ThumbnailItem
              key={i}
              index={i}
              position={position}
              page={pages[i]}
              store={store}
              keyTab={keyIndex === null ? null : keyIndex === i}
              drawer={drawer}
              selected={selected.has(i)}
              lifted={dragging?.has(i) === true}
              movable={onMove !== undefined}
              onPick={onPick}
              onPress={onPointerDown}
              onMenu={onContextMenu}
            />
          ))}
      </ol>
      <div ref={line} className={styles.dropLine} hidden aria-hidden="true" />
    </nav>
  );
}

interface ThumbnailItemProps {
  /** The page (an original index). */
  index: number;
  /** Where it is shown (R108): its page number is position + 1. */
  position: number;
  page: PageSize;
  store: ViewerStore;
  /** Whether the arrow keys put the tab stop here; null: it is on the page in view. */
  keyTab: boolean | null;
  drawer: ThumbnailDrawer;
  /** Picked with Ctrl- or Shift-click, to move with the others. */
  selected: boolean;
  /** Being dragged: drawn faded in its old place. */
  lifted: boolean;
  /** The pages can be moved (R108). */
  movable: boolean;
  onPick: (i: number, e: ReactMouseEvent<HTMLButtonElement>) => void;
  onPress: (i: number, e: ReactPointerEvent<HTMLButtonElement>) => void;
  onMenu: (i: number, e: ReactMouseEvent<HTMLButtonElement>) => void;
}

/** One thumbnail. It reads "is this the page in view" itself, so a page change re-renders two thumbnails, not the list. */
const ThumbnailItem = memo(function ThumbnailItem({ index, position, page, store, keyTab, drawer, selected, lifted, movable, onPick, onPress, onMenu }: ThumbnailItemProps) {
  const current = useViewerState(store, (s) => s.currentPage === index);
  const button = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const el = button.current!;
    drawer.attach(index, el, canvas.current!);
    return () => drawer.detach(index, el);
  }, [drawer, index]);
  const upright = displayedSize(page, 0);
  const number = position + 1;
  return (
    <li className={styles.item} data-selected={selected ? '' : undefined} data-lifted={lifted ? '' : undefined}>
      <span className={styles.number} aria-hidden="true">
        {number}
      </span>
      <button
        ref={button}
        type="button"
        className={styles.thumb}
        data-thumb-index={index}
        aria-label={selected ? `Page ${number}, selected` : `Page ${number}`}
        aria-current={current ? 'page' : undefined}
        aria-keyshortcuts={movable ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
        tabIndex={(keyTab ?? current) ? 0 : -1}
        // Its shape, turned with the view by the list's data-sideways (ThumbnailRail.module.css).
        style={{ '--upright-w': upright.width, '--upright-h': upright.height } as CSSProperties}
        // A click shows the page without taking the focus, so the reading keys keep moving the pages.
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => onPress(index, e)}
        onContextMenu={(e) => onMenu(index, e)}
        // No browser drag of the canvas picture
        onDragStart={(e) => e.preventDefault()}
        onClick={(e) => {
          // The focus moves to the clicked thumbnail only if it was in the list already.
          if (e.currentTarget.parentElement?.parentElement?.contains(document.activeElement)) e.currentTarget.focus();
          onPick(index, e);
        }}
      >
        <canvas ref={canvas} className={styles.canvas} width={0} height={0} aria-hidden="true" />
      </button>
    </li>
  );
});
