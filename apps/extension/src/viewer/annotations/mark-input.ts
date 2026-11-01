// How the person marks text (Phase 2, S13): the mark keys, the mark-up menu's triggers, and a focused mark's keys.
//
// - With text selected: H highlights, Ctrl+U underlines, Ctrl+B bolds, Alt+Shift+5 strikes through (commands.ts). Each
//   applies at once to the selection; pressing it again over the same text takes it off. The selection stays, so styles
//   can be stacked (highlight plus underline).
// - Colour: a style the selection already has all over, in one colour, is toggled in that colour (so H always takes a
//   highlight off again, whatever its colour). Otherwise H, the menu and the line styles use marks.lastColor. Picking a
//   colour in the menu highlights in that colour and makes it the last colour.
// - The menu opens only with text selected: on right-click over the pages, the menu key or Shift+F10. Shift+right-click,
//   or a right-click with nothing selected, gives Chrome's own menu. Nothing ever opens by itself.
// - A click on a mark focuses it (a ring shows). Then 1 to 5 recolour it, Delete removes it, Tab and Shift+Tab move to the
//   next or previous mark, and Esc lets go. A click on a commented passage makes its thread the active one.
// - Speed: each style action is timed from the key or click to the moment the mark layer has drawn it, and recorded
//   as the performance mark `sop:mark-drawn` (detail: { ms, style }); the budget is 50 ms (spec "Speed budgets").
import type { MarkColor, MarkId, MarkStyle } from '@sop/core';
import { MARK_COLOR_NAMES, markColorForKey } from '@sop/ui';
import { type CharRange, charAtPoint, type PageSize } from '@sop/viewer';
import type { MarkLayerItem, PageListApi, TextSelectionSource } from '@sop/viewer/react';
import type { RefObject } from 'react';
import type { CommandBehaviour, ViewerCommandId } from '../commands';
import { installShortcuts, type ShortcutDef } from '../shortcuts';
import type { AnnotationSession } from './session';

type TextStyle = Exclude<MarkStyle, 'area'>;

/** A request to show the mark-up menu: where, over which chars, and their words (for Search). */
export interface MenuRequest {
  at: { x: number; y: number };
  ranges: CharRange[];
  text: string;
}

export interface MarkInputDeps {
  session: AnnotationSession;
  /** The marks drawn on a page (the mark layer's model), for hit-testing a click. */
  layer: { marksOn(pageIndex: number): readonly MarkLayerItem[] };
  pages: readonly PageSize[];
  pageList: RefObject<PageListApi | null>;
  selection(): CharRange[];
  /** The text layer's selection model: the menu's text and place come from it, never from the DOM selection. */
  textSelection: TextSelectionSource;
  /** A short note at the bottom of the window (a selection too big to mark). */
  showNote(text: string): void;
  lastColor(): MarkColor;
  setLastColor(c: MarkColor): void;
  /** Starts reading a page's aligned text (PageTextProvider.rawText), so an anchor on it never waits for the engine. */
  warm(pageIndex: number): void;
}

export interface MarkInput {
  /** Applies a style to the selection (or to `ranges`). `color` is an explicit pick from the menu. */
  apply(style: TextStyle, o?: { color?: MarkColor; ranges?: CharRange[] }): void;
  /** The colour the menu shows checked for these chars: the highlight they all have, else the last colour. */
  menuColour(ranges: CharRange[]): MarkColor;
  readonly menu: {
    get(this: void): MenuRequest | null;
    subscribe(this: void, cb: () => void): () => void;
    close(this: void): void;
  };
  /** What the mark commands do (commands.ts holds their names and keys). */
  behaviours(): Partial<Record<ViewerCommandId, CommandBehaviour>>;
  /** Where the pointer last was over the pages, in client px. */
  pointer(): { x: number; y: number } | null;
  /** The mark layer has drawn a change (the end of a timed action). */
  drawn(pageIndex: number, what: 'marks' | 'bold'): void;
  dispose(): void;
}

/** The page list's scroll area: the pages live in it. */
function scroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="document"]');
}

/** A menu or a dialog has the focus or is open: its own keys come first. */
export function overlayOpen(): boolean {
  const a = document.activeElement;
  if (a instanceof Element && a.closest('[role="menu"], [role="menubar"] [aria-expanded="true"], [role="dialog"], [role="alertdialog"], [role="listbox"]') !== null) return true;
  return document.querySelector('[role="menu"][data-state="open"], [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]') !== null;
}

/** A dialog is open (it has a scrim over the pages). */
function dialogOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]') !== null;
}

/** The focus is on the pages (or on nothing): keys such as Tab belong to a focused mark, not to the chrome. */
function focusOnPages(): boolean {
  const a = document.activeElement;
  return a === null || a === document.body || a === document.documentElement || a.closest('[role="document"]') !== null;
}

function overPages(x: number, y: number): boolean {
  const r = scroller()?.getBoundingClientRect();
  return r !== undefined && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/**
 * Where the menu opens for the menu key or Shift+F10: just after the end of the selection (the end of its last line
 * painted on screen), kept inside the pages.
 */
function selectionEnd(selection: TextSelectionSource): { x: number; y: number } | null {
  const last = selection.point('end');
  const area = scroller()?.getBoundingClientRect();
  if (last === null || area === undefined) return null;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  return { x: clamp(last.x, area.left + 8, area.right - 8), y: clamp(last.y, area.top + 8, area.bottom - 8) };
}

/**
 * Marks and notes act on a selection of at most this many pages. Ctrl+A then H would otherwise highlight a whole book by
 * accident: one mark holding the text of every page as its quote, written to the library. A bigger selection is refused
 * with a note (TOO_MUCH_TO_MARK), never cut down without saying so.
 */
export const MARK_MAX_PAGES = 10;
export const TOO_MUCH_TO_MARK = 'That’s too much text to mark. Select 10 pages or less.';
export const TOO_MUCH_FOR_A_NOTE = 'That’s too much text for one note. Select 10 pages or less.';

/** Whether char ranges cover more pages than a mark or a note may (MARK_MAX_PAGES). */
export function tooMuchToMark(ranges: readonly CharRange[]): boolean {
  if (ranges.length === 0) return false;
  const pages = ranges.map((r) => r.pageIndex);
  return Math.max(...pages) - Math.min(...pages) + 1 > MARK_MAX_PAGES;
}

/** The selected text the menu's Search reads (it sends at most a few hundred chars). */
const MENU_TEXT_CHARS = 2000;

/** How long after a right button press its contextmenu event counts as the mouse's (after that it is the keyboard's). */
const RIGHT_PRESS_MS = 1000;
/** The one contextmenu event that comes this soon after the menu key or Shift+F10 opened our menu is that key's, and is ignored. */
const KEY_MENU_MS = 800;
/** A timed action that draws nothing in this long is dropped (H over spaces only, say). */
const TIMING_MAX_MS = 2000;
/** Hit-test slack round a mark, as a share of the page (about 2 CSS px at 100%). */
const HIT_PAD = 0.003;
/** Tab to a mark this close to the top or bottom of the pages scrolls it to the middle. */
const REVEAL_MARGIN = 40;

const STYLE_WORDS: Record<MarkStyle, string> = { highlight: 'highlight', underline: 'underline', bold: 'bold', strike: 'strikethrough', area: 'area' };

export function createMarkInput(d: MarkInputDeps): MarkInput {
  const { session } = d;
  let menuReq: MenuRequest | null = null;
  const menuListeners = new Set<() => void>();
  let lastRightPress = -Infinity;
  let lastShiftRightPress = false;
  let keyMenuAt = -Infinity;
  let pointerAt: { x: number; y: number } | null = null;
  let timing: { t0: number; style: TextStyle; timer: ReturnType<typeof setTimeout> } | null = null;
  const listeners = new AbortController();
  const signal = listeners.signal;

  // A polite live region: what a focused mark is, and which keys act on it, for screen readers.
  const live = document.createElement('div');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  Object.assign(live.style, { position: 'fixed', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' });
  document.body.appendChild(live);
  const announce = (text: string) => {
    live.textContent = text;
  };

  const editable = () => session.state().mode !== 'view-only';

  function setMenu(next: MenuRequest | null): void {
    menuReq = next;
    for (const l of [...menuListeners]) l();
  }

  function openMenu(at: { x: number; y: number }, ranges: CharRange[]): void {
    setMenu({ at, ranges, text: d.textSelection.text(MENU_TEXT_CHARS) });
  }

  // ---- styles

  /** The one colour a style already has over all of these chars, or null (not all covered, or in several colours). */
  function coveringColour(style: TextStyle, ranges: CharRange[]): MarkColor | null {
    const state = session.state();
    let colour: MarkColor | null | undefined;
    for (const r of ranges) {
      if (r.end <= r.start) continue;
      const spans: [number, number, MarkColor | null][] = [];
      for (const m of state.marks) {
        if (m.style !== style) continue;
        const placed = state.placement.get(m.id);
        const a = placed?.placed === true ? placed.anchor : null;
        if (a?.kind !== 'text' || r.pageIndex < a.start.page || r.pageIndex > a.end.page) continue;
        const s = a.start.page === r.pageIndex ? a.start.index : 0;
        const e = a.end.page === r.pageIndex ? a.end.index : Infinity;
        if (e > r.start && s < r.end) spans.push([s, e, m.color]);
      }
      spans.sort((x, y) => x[0] - y[0]);
      let cursor = r.start;
      for (const [s, e, c] of spans) {
        if (s > cursor) break;
        cursor = Math.max(cursor, e);
        if (colour === undefined) colour = c;
        else if (colour !== c) return null;
        if (cursor >= r.end) break;
      }
      if (cursor < r.end) return null;
    }
    return colour ?? null;
  }

  function startTiming(style: TextStyle): void {
    if (timing) clearTimeout(timing.timer);
    timing = { t0: performance.now(), style, timer: setTimeout(() => (timing = null), TIMING_MAX_MS) };
  }

  function apply(style: TextStyle, o: { color?: MarkColor; ranges?: CharRange[] } = {}): void {
    if (!editable()) return;
    const ranges = (o.ranges ?? d.selection()).filter((r) => r.end > r.start);
    if (ranges.length === 0) return;
    if (tooMuchToMark(ranges)) {
      d.showNote(TOO_MUCH_TO_MARK);
      return;
    }
    let color: MarkColor | null = null;
    if (style !== 'bold') {
      if (o.color !== undefined) {
        color = o.color;
        d.setLastColor(o.color);
      } else color = coveringColour(style, ranges) ?? d.lastColor();
    }
    startTiming(style);
    void session.applyStyle(ranges, style, color);
  }

  // ---- the focused mark

  function placedMarks(): MarkId[] {
    const state = session.state();
    return state.marks.filter((m) => state.placement.get(m.id)?.placed === true).map((m) => m.id);
  }

  function describe(id: MarkId): string {
    const m = session.state().marks.find((x) => x.id === id);
    if (!m) return '';
    const what = m.color === null ? STYLE_WORDS[m.style] : `${MARK_COLOR_NAMES[m.color]} ${STYLE_WORDS[m.style]}`;
    const recolour = m.color === null ? '' : ' Press 1 to 5 to change its colour,';
    return `${what[0]?.toUpperCase() ?? ''}${what.slice(1)} selected.${recolour} Delete removes it, Esc lets go.`;
  }

  function focusMark(id: MarkId | null): void {
    session.setFocusedMark(id);
    announce(id === null ? '' : describe(id));
  }

  /** Scrolls the page list just enough to show a mark's first rect. */
  function reveal(id: MarkId): void {
    const state = session.state();
    const r = state.placement.get(id);
    const a = r?.placed === true ? r.anchor : null;
    const pages = d.pageList.current;
    const area = scroller();
    if (!a || !pages || !area) return;
    let page: number;
    let u: number;
    let v: number;
    if (a.kind === 'text') {
      const first = a.rects.find((x) => x.rects.length > 0);
      page = first?.page ?? a.start.page;
      const n = first?.rects[0];
      [u, v] = n ? [(n[0] + n[2]) / 2, (n[1] + n[3]) / 2] : [0.5, 0];
    } else if (a.kind === 'area' || a.kind === 'figure') {
      page = a.page;
      [u, v] = [(a.rect[0] + a.rect[2]) / 2, (a.rect[1] + a.rect[3]) / 2];
    } else return;
    const size = d.pages[page];
    if (size === undefined) return;
    const at = pages.clientPointOf({ pageIndex: page, x: u * size.width, y: v * size.height });
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) {
      void pages.goToPage(page); // no position for it yet: go to its page
      return;
    }
    const box = area.getBoundingClientRect();
    const inView = at.y >= box.top + REVEAL_MARGIN && at.y <= box.bottom - REVEAL_MARGIN && at.x >= box.left && at.x <= box.right;
    if (inView) return;
    area.scrollTop += at.y - (box.top + box.height / 2);
    if (at.x < box.left || at.x > box.right) area.scrollLeft += at.x - (box.left + box.width / 2);
  }

  function step(dir: 1 | -1): void {
    const order = placedMarks();
    const now = session.state().focusedMark;
    if (order.length === 0 || now === null) return;
    const i = order.indexOf(now);
    const next = order[(((i < 0 ? 0 : i + dir) % order.length) + order.length) % order.length];
    if (next === undefined) return;
    focusMark(next);
    reveal(next);
  }

  const focused = () => session.state().focusedMark;
  const markKeysOn = () => focused() !== null && editable() && !overlayOpen();
  const colourKeys: ShortcutDef[] = [1, 2, 3, 4, 5].map((n) => ({
    id: `marks.focused.colour${n}`,
    keys: [`Digit${n}`, `Numpad${n}`],
    enabled: () => markKeysOn() && session.state().marks.find((m) => m.id === focused())?.color !== null,
    run: (e) => {
      const c = markColorForKey(e);
      const id = focused();
      if (c === null || id === null) return;
      d.setLastColor(c);
      startTiming('highlight');
      void session.recolor(id, c);
      announce(`${MARK_COLOR_NAMES[c]}.`);
    },
  }));
  const offKeys = installShortcuts([
    ...colourKeys,
    {
      id: 'marks.focused.delete',
      keys: ['Delete', 'Backspace'],
      enabled: markKeysOn,
      run: () => {
        const id = focused();
        if (id === null) return;
        startTiming('highlight');
        void session.removeMark(id);
        session.setFocusedMark(null);
        announce('Removed.');
      },
    },
    { id: 'marks.focused.next', keys: ['Tab'], enabled: () => markKeysOn() && focusOnPages(), run: () => step(1) },
    { id: 'marks.focused.previous', keys: ['Shift+Tab'], enabled: () => markKeysOn() && focusOnPages(), run: () => step(-1) },
    { id: 'marks.focused.release', keys: ['Escape'], enabled: () => focused() !== null && !overlayOpen(), run: () => focusMark(null) },
  ]);

  /** The topmost mark under a client point, or null. */
  function markAt(x: number, y: number): MarkId | null {
    const p = d.pageList.current?.pdfPointAt(x, y);
    const size = p ? d.pages[p.pageIndex] : undefined;
    if (!p || !size) return null;
    const u = p.x / size.width;
    const v = p.y / size.height;
    const items = d.layer.marksOn(p.pageIndex);
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it === undefined) continue;
      if (it.rects.some((r) => u >= r[0] - HIT_PAD && u <= r[2] + HIT_PAD && v >= r[1] - HIT_PAD && v <= r[3] + HIT_PAD)) return it.id as MarkId;
    }
    return null;
  }

  // ---- listeners

  window.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button === 2) {
        lastRightPress = performance.now();
        lastShiftRightPress = e.shiftKey;
      }
      // The page's aligned text is what an anchor is cut from. Read it now, while the person is still selecting, so a
      // mark never waits for it behind page renders in the engine's queue.
      const p = d.pageList.current?.pdfPointAt(e.clientX, e.clientY);
      if (p) d.warm(p.pageIndex);
    },
    { signal, capture: true },
  );

  // A right press over the pages keeps the selection, wherever it lands, as in Chrome's own PDF viewer: the browser
  // would otherwise drop the selection when the press is beside it, and the menu would have nothing to act on. That
  // holds while a menu is open too (the press closes it, and the menu opens again there). Shift+right-click is left
  // alone (Chrome's menu, and the browser's own selection rules), and so is a press under an open dialog.
  window.addEventListener(
    'mousedown',
    (e) => {
      if (e.button !== 2 || e.shiftKey || !editable() || dialogOpen() || !overPages(e.clientX, e.clientY)) return;
      if (d.selection().length > 0) e.preventDefault();
    },
    { signal, capture: true },
  );

  window.addEventListener(
    'contextmenu',
    (e) => {
      if (e.defaultPrevented) return; // our own menu, or another part of the viewer, took it
      const now = performance.now();
      const keyOpened = keyMenuAt;
      keyMenuAt = -Infinity;
      if (now - keyOpened < KEY_MENU_MS) {
        e.preventDefault(); // the key that just opened our menu also asks for the browser's: ours is already open
        return;
      }
      const byMouse = now - lastRightPress < RIGHT_PRESS_MS;
      if (byMouse && (lastShiftRightPress || e.shiftKey)) return; // Shift+right-click: Chrome's menu
      if (!editable() || (byMouse && !overPages(e.clientX, e.clientY))) return;
      if (dialogOpen()) return;
      const ranges = d.selection();
      if (ranges.length === 0) return; // nothing selected: Chrome's menu
      const at = byMouse ? { x: e.clientX, y: e.clientY } : selectionEnd(d.textSelection);
      if (at === null) return;
      e.preventDefault();
      openMenu(at, ranges);
    },
    { signal },
  );

  window.addEventListener(
    'pointermove',
    (e) => {
      pointerAt = overPages(e.clientX, e.clientY) ? { x: e.clientX, y: e.clientY } : null;
    },
    { signal, passive: true },
  );

  window.addEventListener(
    'click',
    (e) => {
      if (e.button !== 0 || e.detail > 1 || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      if (!(e.target instanceof Node) || scroller()?.contains(e.target) !== true) return;
      if (d.selection().length > 0) return; // the click ended a selection
      const id = markAt(e.clientX, e.clientY);
      if (id !== session.state().focusedMark) focusMark(id);
      // A click on a commented passage opens its thread (the card and its mark go active together).
      const root = scroller();
      const hit = root ? charAtPoint(root, e.clientX, e.clientY) : null;
      const thread = hit ? session.threadAt({ pageIndex: hit.pageIndex, start: hit.charIndex, end: hit.charIndex }) : null;
      if (thread !== null) session.setActive(thread);
    },
    { signal },
  );

  // A new selection lets go of the focused mark: the keys then act on the selection.
  const offSelection = d.textSelection.subscribe(() => {
    if (d.selection().length > 0 && session.state().focusedMark !== null) focusMark(null);
  });

  return {
    apply,
    menuColour: (ranges) => coveringColour('highlight', ranges) ?? d.lastColor(),
    menu: {
      get: () => menuReq,
      subscribe(cb) {
        menuListeners.add(cb);
        return () => menuListeners.delete(cb);
      },
      close: () => setMenu(null),
    },
    behaviours() {
      const canMark = () => editable() && !overlayOpen() && d.selection().length > 0;
      const style = (s: TextStyle): CommandBehaviour => ({ run: () => apply(s), enabled: canMark });
      return {
        'marks.highlight': style('highlight'),
        'marks.underline': style('underline'),
        'marks.bold': style('bold'),
        'marks.strike': style('strike'),
        'marks.menu': {
          enabled: canMark,
          run: () => {
            const at = selectionEnd(d.textSelection);
            const ranges = d.selection();
            if (at === null || ranges.length === 0) return;
            keyMenuAt = performance.now();
            openMenu(at, ranges);
          },
        },
        'edit.undo': { run: () => void session.undo(), enabled: () => editable() && !overlayOpen() },
        'edit.redo': { run: () => void session.redo(), enabled: () => editable() && !overlayOpen() },
      };
    },
    pointer: () => pointerAt,
    drawn(_pageIndex, what) {
      const t = timing;
      if (t === null || (t.style === 'bold') !== (what === 'bold')) return;
      clearTimeout(t.timer);
      timing = null;
      const ms = performance.now() - t.t0;
      performance.mark('sop:mark-drawn', { detail: { ms, style: t.style } });
    },
    dispose() {
      listeners.abort();
      offSelection();
      offKeys();
      if (timing) clearTimeout(timing.timer);
      live.remove();
      menuListeners.clear();
    },
  };
}
