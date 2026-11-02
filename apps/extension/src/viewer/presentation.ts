// Presentation mode (Task 26): View → Presentation mode. The page area goes full screen, on black, one page fit to the
// screen, with no header, toolbar, rail or margin cards; marks show, notes do not (presentation.css).
//
// - The page list lays the pages out one a screen while the store's `presenting` is set, and follows its page; its
//   reading moves step a page there (→ ↓ Space Page Down forward, ← ↑ Shift+Space Page Up back, Home and End), so the
//   reading keys need nothing of their own here. A click on the right half of the screen goes forward, on the left
//   half back, and a turn of the wheel steps one page.
// - Every other command is off while presenting (commands.ts), and every other listener of the page is kept from the
//   pointer and the keys, so nothing opens behind the black screen.
// - The cursor hides after 2 s without moving.
// - Esc, or leaving full screen any other way (F11, the browser's own Esc, another window), ends it and puts back the
//   zoom, the scroll position and the page exactly as they were. Nothing of it is saved.
// - Where the browser refuses full screen, it presents inside the window the same way.
import type { ViewerSnapshot, ViewerStore } from '@sop/viewer';
import { flushSync } from 'react-dom';
import './presentation.css';

/** The cursor hides after this long without moving. */
export const CURSOR_HIDE_MS = 2000;
/** Wheel distance (CSS px) that steps one page; the rest of the same turn of the wheel is ignored. */
const WHEEL_STEP_PX = 40;
/** A turn of the wheel ends when no wheel event has come for this long (a trackpad's momentum goes on for a while). */
const WHEEL_GESTURE_MS = 200;
/**
 * After leaving, the old place is put back as the window settles to its old size, for up to this long, and until it
 * has held for STABLE_FRAMES frames or the reader moves the pages themselves.
 */
const RESTORE_WINDOW_MS = 1500;
const STABLE_FRAMES = 3;
/** Wheel lines and pages in px, for deltaMode 1 and 2 (as zoom.ts counts them). */
const LINE_PX = 40;
const PAGE_PX = 800;

/** What a presentation needs: the tab's view state, and the viewer whose page area it shows (or that area itself). */
export interface PresentationContext {
  store: ViewerStore;
  root: HTMLElement;
}

/** Where the reader was, put back exactly when the presentation ends. */
interface Before {
  zoom: ViewerSnapshot['zoom'];
  scale: number;
  page: number;
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The presentation running in this tab, if any. `left`: it was full screen and is not any more. */
let running: { area: HTMLElement; exit: () => void; finish: () => void; left: () => boolean } | null = null;

/**
 * Ends the presentation now if its page area has left full screen and the browser's fullscreenchange (which comes a
 * frame after document.fullscreenElement is null) has not come yet. Whatever reads the view state (the viewer's test
 * hooks) calls this first, so nothing ever reads the page out of full screen but still presenting.
 */
export function settlePresentation(): void {
  if (running?.left()) running.finish();
}

/** The page area: `root` itself when it is the page list's scroller, else the one inside it. */
function pageArea(root: HTMLElement): HTMLElement | null {
  return root.matches('[role="document"]') ? root : root.querySelector<HTMLElement>('[role="document"]');
}

/**
 * Starts presentation mode at the page in view: the page area goes full screen (requestFullscreen, which needs the
 * click or key that asked for it) and shows that page fit to the screen. Resolves with exit(), which ends it as Esc
 * does; calling it twice is harmless. While a presentation is running, resolves with its exit.
 */
export async function enterPresentation(ctx: PresentationContext): Promise<() => void> {
  const { store } = ctx;
  const area = pageArea(ctx.root);
  if (!area) throw new Error('presentation mode: there are no pages to show');
  if (running?.area === area) return running.exit;
  running?.finish(); // a presentation of a document that has gone (the engine was started again under it)
  const s = store.get();
  const before: Before = {
    zoom: s.zoom,
    scale: s.scale,
    page: s.currentPage,
    top: area.scrollTop,
    left: area.scrollLeft,
    width: area.clientWidth,
    height: area.clientHeight,
  };

  const signal = new AbortController();
  const on = <K extends keyof WindowEventMap>(type: K, f: (e: WindowEventMap[K]) => void, o: AddEventListenerOptions = {}) =>
    window.addEventListener(type, f, { ...o, capture: true, signal: signal.signal });
  let ended = false;
  let wasFullscreen = false;

  const step = (dir: 1 | -1) => {
    const now = store.get().presenting;
    if (now) store.set({ presenting: { page: Math.max(0, now.page + dir) } }); // the page list stops it at the last page
  };

  // The cursor: hidden after CURSOR_HIDE_MS still, back on the next move.
  let cursorTimer: ReturnType<typeof setTimeout> | undefined;
  const showCursor = () => {
    area.removeAttribute('data-cursor-hidden');
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => area.setAttribute('data-cursor-hidden', ''), CURSOR_HIDE_MS);
  };

  const finish = () => {
    if (ended) return;
    ended = true;
    running = null;
    signal.abort();
    clearTimeout(cursorTimer);
    area.removeAttribute('data-cursor-hidden');
    // The page list lays the pages out at the old size in this same call (it measures its area when presenting ends).
    flushSync(() => store.set({ presenting: null, zoom: before.zoom }));
    holdPlace(area, store, before);
  };

  const exit = () => {
    if (ended) return;
    // Put back as the way out settles (the same task that leaves full screen), not a frame later with the event.
    if (document.fullscreenElement === area) document.exitFullscreen().then(finish, finish);
    else finish();
  };

  // ---- the keys: the reading keys step through the page list (installShortcuts runs before this); Esc ends it.
  on('keydown', (e) => {
    e.stopPropagation(); // nothing else on the page (the selection, the notes, figures) acts behind the black screen
    if (e.key === 'Escape') {
      e.preventDefault();
      exit();
    }
  });
  on('keyup', (e) => e.stopPropagation());

  // ---- the pointer: a click steps by the half it lands on; nothing selects, drags, hovers or opens a menu.
  for (const type of ['pointerdown', 'pointerup', 'mouseup', 'dblclick', 'auxclick', 'contextmenu', 'dragstart', 'selectstart'] as const) {
    on(type, (e: Event) => e.stopPropagation());
  }
  on('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault(); // no focus moves and no text is selected
  });
  on('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0) return;
    const r = area.getBoundingClientRect();
    step(e.clientX >= r.left + r.width / 2 ? 1 : -1);
  });
  for (const type of ['pointermove', 'mousemove'] as const) {
    on(type, (e: Event) => {
      e.stopPropagation();
      showCursor();
    });
  }

  // ---- the wheel: one page a turn (Ctrl+wheel does not zoom here).
  let wheelSum = 0;
  let wheelStepped = false;
  let wheelTimer: ReturnType<typeof setTimeout> | undefined;
  on(
    'wheel',
    (e) => {
      e.stopPropagation();
      e.preventDefault();
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => {
        wheelSum = 0;
        wheelStepped = false;
      }, WHEEL_GESTURE_MS);
      if (wheelStepped || e.ctrlKey) return;
      wheelSum += (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * (e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? PAGE_PX : 1);
      if (Math.abs(wheelSum) < WHEEL_STEP_PX) return;
      wheelStepped = true;
      step(wheelSum > 0 ? 1 : -1);
    },
    { passive: false },
  );

  // ---- full screen: leaving it any way (Esc, F11, another window, a script) ends the presentation, on fullscreenchange.
  // That event comes a frame after document.fullscreenElement is null; in between, settlePresentation() ends it for
  // whatever reads the view state.
  document.addEventListener(
    'fullscreenchange',
    () => {
      if (document.fullscreenElement === area) wasFullscreen = true;
      else if (wasFullscreen) finish();
    },
    { signal: signal.signal },
  );

  running = { area, exit, finish, left: () => wasFullscreen && document.fullscreenElement !== area };
  flushSync(() => store.set({ presenting: { page: before.page }, zoom: { kind: 'fit-page' } }));
  area.focus({ preventScroll: true });
  showCursor();
  try {
    await area.requestFullscreen({ navigationUI: 'hide' });
    wasFullscreen = document.fullscreenElement === area;
  } catch {
    // Refused (no click to ask with, or not allowed here): the presentation goes on inside the window.
  }
  return exit;
}

/**
 * Puts the reader back where they were: the scroll position, once the page area is back at its old size and the pages
 * at their old scale. The page list lays itself out again as the window settles (the browser shows its toolbars again
 * after full screen), so the place is checked each frame and put back if anything moved it, until it has held for
 * STABLE_FRAMES frames, the reader moves the pages, or RESTORE_WINDOW_MS has passed.
 */
function holdPlace(area: HTMLElement, store: ViewerStore, before: Before): void {
  const until = performance.now() + RESTORE_WINDOW_MS;
  const stop = new AbortController();
  for (const type of ['wheel', 'keydown', 'pointerdown'] as const) window.addEventListener(type, () => stop.abort(), { capture: true, passive: true, signal: stop.signal });
  let stable = 0;
  /** True when the view is the old one and the old place is on screen. */
  const put = (): boolean => {
    const sameView = area.clientWidth === before.width && area.clientHeight === before.height && Math.abs(store.get().scale - before.scale) < 1e-9;
    if (!sameView) return false;
    if (area.scrollTop !== before.top || area.scrollLeft !== before.left) {
      area.scrollTop = before.top;
      area.scrollLeft = before.left;
      // The page list reads its scroll position on scroll events; this one is told now, so the page in view (and the
      // page box) is right at once, not a frame later.
      area.dispatchEvent(new Event('scroll'));
    }
    return area.scrollTop === before.top && area.scrollLeft === before.left;
  };
  put();
  const frame = () => {
    // Presenting again (that presentation holds its own place), or the reader is moving the pages.
    if (stop.signal.aborted || store.get().presenting !== null || !area.isConnected) return stop.abort();
    stable = put() ? stable + 1 : 0;
    if (stable >= STABLE_FRAMES || performance.now() > until) return stop.abort();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
