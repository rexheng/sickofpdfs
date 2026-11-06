// Presentation mode (Task 26): View → Presentation mode. The page area goes full screen, on black, one page fit to the
// screen, with no header, toolbar, rail or margin cards; marks show, notes do not (presentation.css).
//
// - The page list lays the pages out one a screen while the store's `presenting` is set, and follows its page; its
//   reading moves step a page there (→ ↓ Space Page Down forward, ← ↑ Shift+Space Page Up back, Home and End), so the
//   reading keys need nothing of their own here. A click on the right half of the screen goes forward, on the left
//   half back, and a turn of the wheel steps one page.
// - Every other command is off while presenting (commands.ts), and every other listener of the page is kept from the
//   pointer and the keys, so nothing opens behind the black screen. The rest of the viewer is hidden and inert, and so
//   is anything that appears while it runs (the "not sure" banner, a snackbar); a dialog that appears (a question
//   that needs an answer) ends the presentation, so it is never answered blind.
// - The cursor hides after 2 s without moving.
// - Esc, or leaving full screen any other way (F11, the browser's own Esc, another window), ends it on the page the
//   reader reached (R99), and puts back the zoom and the rail; on the page it started on, the exact scroll position too.
//   The focus goes back where it was. Nothing of it is saved.
// - Where the browser refuses full screen, presentation mode does not start, and a note says so.
import { PAGE_GAP, type ViewerSnapshot, type ViewerStore } from '@sop/viewer';
import type { PageListApi } from '@sop/viewer/react';
import type { RefObject } from 'react';
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
  /** The page list, to show the page the reader reached when it ends (R99). */
  pageList?: RefObject<PageListApi | null>;
  /** The snackbar, for "full screen was refused". */
  ui?: { showNote(this: void, text: string): void };
}

/** Said when the browser refuses full screen: presentation mode does not start. */
export const FULLSCREEN_REFUSED = 'Presentation mode needs full screen, and this window can’t go full screen.';

/** Where the reader was, put back exactly when the presentation ends. */
interface Before {
  zoom: ViewerSnapshot['zoom'];
  scale: number;
  page: number;
  top: number;
  left: number;
  width: number;
  /** The area's bottom edge in the window: back where it was once the window is (a bar above the pages moves only its top). */
  bottom: number;
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

/**
 * Hides everything on the page but `area` (and the elements that hold it): the header, the toolbar, the rail, the
 * notes panel and any note are made invisible and inert, so they are not shown, read aloud or reached with Tab behind
 * the full screen (or the window, where full screen was refused). Their layout is kept, so leaving puts the pages back
 * exactly. Returns the function that shows them again.
 */
function hideAllBut(area: HTMLElement, onDialog: () => void): () => void {
  const hidden: { el: HTMLElement; inert: boolean }[] = [];
  const hide = (other: Element) => {
    if (!(other instanceof HTMLElement) || other.hasAttribute('data-presenting-hidden')) return;
    hidden.push({ el: other, inert: other.inert });
    other.inert = true;
    other.setAttribute('data-presenting-hidden', '');
  };
  // What appears later beside the page area (the "not sure" banner after 20 s, a snackbar, a dialog's portal) is hidden
  // too; in a window that is not full screen it would otherwise show over the black screen and swallow its clicks.
  const later = new MutationObserver((records) => {
    let dialog = false;
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (!(node instanceof Element)) continue;
        hide(node);
        dialog ||= node.matches(DIALOGS) || node.querySelector(DIALOGS) !== null;
      }
    }
    if (dialog) onDialog();
  });
  for (let el: HTMLElement = area; el.parentElement && el !== document.body; el = el.parentElement) {
    for (const other of el.parentElement.children) if (other !== el) hide(other);
    later.observe(el.parentElement, { childList: true });
  }
  return () => {
    later.disconnect();
    for (const h of hidden) {
      h.el.inert = h.inert;
      h.el.removeAttribute('data-presenting-hidden');
    }
  };
}

/** A question that needs an answer: it ends the presentation rather than wait, unseen, behind it. */
const DIALOGS = '[role="dialog"], [role="alertdialog"]';

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
  const focusBefore = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const before: Before = {
    zoom: s.zoom,
    scale: s.scale,
    page: s.currentPage,
    top: area.scrollTop,
    left: area.scrollLeft,
    width: area.clientWidth,
    bottom: Math.round(area.getBoundingClientRect().bottom),
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

  // A dialog that appears while presenting ends it (exit is defined below; the observer only calls it later).
  const showAll = hideAllBut(area, () => exit());
  const finish = () => {
    if (ended) return;
    ended = true;
    running = null;
    signal.abort();
    clearTimeout(cursorTimer);
    area.removeAttribute('data-cursor-hidden');
    showAll();
    // R99: the page the reader reached stays; the zoom (and the rail, shown again) are put back.
    const reached = store.get().presenting?.page ?? before.page;
    // The page list lays the pages out at the old size in this same call (it measures its area when presenting ends).
    flushSync(() => store.set({ presenting: null, zoom: before.zoom }));
    holdPlace(area, store, before, reached === before.page ? null : { page: reached, pageList: ctx.pageList });
    // The focus goes back where it was before (the pages, or the button that started it), if it is still there.
    if (focusBefore?.isConnected === true && !focusBefore.closest('[inert]')) focusBefore.focus({ preventScroll: true });
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
    // Refused (no click or key to ask with, or not allowed here): it does not start. Nothing is left behind, and the
    // reader is told, rather than given a black window with hidden notices over it.
    finish();
    ctx.ui?.showNote(FULLSCREEN_REFUSED);
  }
  return exit;
}

/**
 * Puts the reader back once the page area is back in the window: at the old scroll position (with the pages at their old
 * scale), or, when the presentation moved on (`reached`), at the top of the page it reached, keeping the old sideways
 * position (R99). The page list lays itself out again as the window settles (the browser shows its toolbars again
 * after full screen), so the place is checked each frame and put back if anything moved it, until it has held for
 * STABLE_FRAMES frames, the reader moves the pages, or RESTORE_WINDOW_MS has passed.
 */
function holdPlace(area: HTMLElement, store: ViewerStore, before: Before, reached: { page: number; pageList: RefObject<PageListApi | null> | undefined } | null): void {
  const until = performance.now() + RESTORE_WINDOW_MS;
  const stop = new AbortController();
  for (const type of ['wheel', 'keydown', 'pointerdown'] as const) window.addEventListener(type, () => stop.abort(), { capture: true, passive: true, signal: stop.signal });
  let stable = 0;
  /** True when the view is the old one and the old place is on screen. */
  /** Where the view goes: the old place, or the top of the page the presentation reached. */
  const target = (): { top: number; left: number } | null => {
    if (reached === null) return before;
    const box = reached.pageList?.current?.pageBoxes()[reached.page];
    return box ? { top: Math.min(Math.ceil(box.top - PAGE_GAP), area.scrollHeight - area.clientHeight), left: before.left } : null;
  };
  const put = (): boolean => {
    // The window is back when the area's width and bottom edge are. Not its height: a bar that shows above the pages as
    // the presentation ends (the not-sure bar falls due behind the black screen, R95) makes it shorter for good, and the
    // place must still come back. The old scale is needed only for the old scroll position; the top of the page reached
    // is found at any scale (fit page follows the height).
    const backInWindow = area.clientWidth === before.width && Math.round(area.getBoundingClientRect().bottom) === before.bottom;
    const sameView = backInWindow && (reached !== null || Math.abs(store.get().scale - before.scale) < 1e-9);
    const to = sameView ? target() : null;
    if (to === null) return false;
    if (area.scrollTop !== to.top || area.scrollLeft !== to.left) {
      area.scrollTop = to.top;
      area.scrollLeft = to.left;
      // The page list reads its scroll position on scroll events; this one is told now, so the page in view (and the
      // page box) is right at once, not a frame later.
      area.dispatchEvent(new Event('scroll'));
    }
    return area.scrollTop === to.top && area.scrollLeft === to.left;
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
