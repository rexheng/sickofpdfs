// Caret browsing (ruling R93): a text cursor for reading and selecting with the keyboard, as in Chrome's caret browsing
// and Foxit's text cursor. TextLayerController owns one; this file is its keys, its moves and its drawing.
//
// - The caret is a CaretPos on the selection's char model (text-layer/caret.ts). A Shift+key selection runs from the
//   selection's anchor (or the caret, when nothing is selected) to the caret's new place, through the controller's own
//   selection model: it is exactly a mouse selection, so Copy, the mark keys, the mark menu and comments read it as one.
//   While something is selected the caret is at the selection's moving end (its focus).
// - With the switch on, a click on a page puts the caret at the nearest place between two letters (a drag still
//   selects), and the moving keys move it in PDFium's reading order, across pages: pages without glyphs read yet are
//   read through the controller's source (the page text provider), and pages with no text are skipped.
// - Without the switch, the keys are the page list's (they scroll); only Shift+keys after a mouse selection move its end.
// - The caret is drawn on its page as a thin line over the text layer, turned with the page (view/page-transform.ts
//   through layout/page-space.ts); it blinks unless the reader asked for reduced motion, and the view scrolls to keep it
//   in sight. A polite live region tells a screen reader the line the caret moves to.
import type { PageGlyphs, PageSize } from '../backend/types';
import type { PageBox } from '../layout/page-layout';
import { contentPointToPage, cssPerPoint, pagePointToContent, pageToDisplayed } from '../layout/page-space';
import {
  caretAt,
  type CaretPos,
  lineTextOf,
  type PageCaret,
  pageCaret,
  stepChar,
  stepWord,
  stopIndexOf,
  stopNear,
  stopOnLine,
  stopPoint,
  stopSegment,
} from '../text-layer/caret';
import { wordSegments } from '../text-layer/items';
import type { PageListApi } from './PageList';
import type { CharPos, TextSelection } from './TextLayer';

/** What the caret asks of TextLayerController. */
export interface CaretHost {
  pages: PageSize[];
  /** The page's glyphs if they are read already. */
  cachedGlyphs(pageIndex: number): PageGlyphs | undefined;
  /** The page's glyphs, read from the source when they are not cached. */
  glyphs(pageIndex: number): Promise<PageGlyphs>;
  selection(): TextSelection | null;
  /**
   * Makes `s` the selection (null, or an empty one, clears it), as the keys and a drag do. `soon`: a held key is
   * repeating, so the DOM selection may follow once it stops (the model, its paint and Copy are up to date at once).
   */
  select(s: TextSelection | null, soon?: boolean): void;
  /** A mounted page's box and the element the caret is drawn in; null when the page is not mounted. */
  mounted(pageIndex: number): { box: PageBox; caret: HTMLElement } | null;
  /** The page list's scroll area (`[role="document"]`). */
  scroller(): HTMLElement | null;
  pageList(): PageListApi | null;
  /** True while the keys belong to something else (presentation mode). */
  paused(): boolean;
  isScannedPage?: (this: void, pageIndex: number) => Promise<boolean>;
  note?: (this: void, text: string) => void;
}

type MoveKind = 'char' | 'word' | 'line' | 'lineEdge' | 'docEdge' | 'screen';

interface Move {
  kind: MoveKind;
  dir: 1 | -1;
  extend: boolean;
  /** The key, for scrolling instead when there is no text to put the caret in. */
  key: string;
  /** The key is held down and repeating. */
  repeat: boolean;
}

/**
 * R93's quiet note, once per tab: the caret skipped a scanned page, or there is no text near the view to put it in (the
 * keys then scroll, as without the switch).
 */
export const CARET_SCAN_NOTE = 'Caret browsing works on text pages. This page is a scanned image.';

/** Pages a move looks through for one with text before it stops (a long run of scanned pages). */
const SKIP_PAGES_MAX = 50;
/** Pages after the view the caret's first place is looked for on (a scanned book has none: the keys then scroll). */
const START_PAGES_AFTER_VIEW = 3;
/** How close (CSS px) the caret may come to the edges of the view before it scrolls: the pill and the find bar sit at the top. */
const VIEW_MARGIN_TOP = 72;
const VIEW_MARGIN = 32;
/** Page Up and Page Down move this much less than the view's height, as the page list's own keys do. */
const SCREEN_OVERLAP_PX = 40;

/** R93's quiet note about scanned pages is shown once per tab. */
let scanNoteShown = false;

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const cmpPos = (a: CharPos, b: CharPos) => a.pageIndex - b.pageIndex || a.charIndex - b.charIndex;

/** The caret move a key asks for, or null. */
function moveOf(e: KeyboardEvent): Move | null {
  const ctrl = e.ctrlKey || e.metaKey;
  const extend = e.shiftKey;
  const m = (kind: MoveKind, dir: 1 | -1): Move => ({ kind, dir, extend, key: e.key, repeat: e.repeat });
  switch (e.key) {
    case 'ArrowRight':
      return m(ctrl ? 'word' : 'char', 1);
    case 'ArrowLeft':
      return m(ctrl ? 'word' : 'char', -1);
    case 'ArrowDown':
      return ctrl ? null : m('line', 1);
    case 'ArrowUp':
      return ctrl ? null : m('line', -1);
    case 'Home':
      return m(ctrl ? 'docEdge' : 'lineEdge', -1);
    case 'End':
      return m(ctrl ? 'docEdge' : 'lineEdge', 1);
    case 'PageDown':
      return ctrl ? null : m('screen', 1);
    case 'PageUp':
      return ctrl ? null : m('screen', -1);
    default:
      return null;
  }
}

export class CaretBrowsing {
  private on = false;
  /** Where the caret is; null before it is placed. While text is selected, the selection's focus. */
  private pos: CaretPos | null = null;
  /** ↑/↓ keep this page point's position across the lines (a text editor's goal column); null after other moves. */
  private goal: { x: number; y: number } | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** The selection is being set by the caret itself: its change is not someone else's. */
  private selecting = false;
  /** The page the caret element is shown on now. */
  private shownOn: HTMLElement | null = null;
  /** The line last told to a screen reader (`page:line`). */
  private toldLine = '';
  private live: HTMLElement | null = null;
  /** Pages known to have no text. */
  private readonly textless = new Set<number>();
  /** Pages whose stops and words are worked out (or asked for) ahead of the keys. */
  private readonly warmed = new WeakSet<PageGlyphs>();
  private readonly ac = new AbortController();
  private readonly offSelection: () => void;

  constructor(
    private readonly host: CaretHost,
    subscribe: (cb: () => void) => () => void,
  ) {
    this.offSelection = subscribe(() => this.onSelectionChange());
    document.addEventListener('focusin', () => this.draw(), { signal: this.ac.signal });
    document.addEventListener('focusout', () => queueMicrotask(() => this.draw()), { signal: this.ac.signal });
  }

  /** Whether the switch is on. */
  get enabled(): boolean {
    return this.on;
  }

  /** The caret, or null (switch off, or not placed yet). */
  position(): CaretPos | null {
    return this.on ? this.pos : null;
  }

  /**
   * Turns caret browsing on or off (the View menu's switch, in this tab or another). Turned on, the caret appears at the
   * selection's end, or at the start of the text at the top of the view.
   */
  setEnabled(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.goal = null;
    if (!on) {
      this.pos = null;
      this.draw();
      return;
    }
    this.enqueue(async () => {
      const sel = this.host.selection();
      const at = (sel && (await this.resolve(this.focusOf(sel)))) ?? (await this.startPos());
      if (at && this.on) this.place(at, { scroll: false, tell: false });
      else if (this.on) this.noteNoText();
    });
  }

  /**
   * The moving keys are the caret's now (the page list's own reading keys step aside): switch on, focus on the pages,
   * and a caret or a selection to move, or text in view to put the caret in. While every page in view is known to have
   * no text (a scanned PDF), the keys scroll at once, as without the switch.
   */
  takesKeys(): boolean {
    if (!this.on || this.host.paused() || !this.inPages()) return false;
    return this.pos !== null || this.host.selection() !== null || !this.viewHasNoText();
  }

  /**
   * A key in the pages (TextLayerController's keydown; fields and dialogs are filtered out before). Returns true when the
   * caret took it. Shift+keys move the selection's end with or without the switch; the other keys only with it.
   */
  onKey(e: KeyboardEvent): boolean {
    if (e.altKey || this.host.paused() || !this.inPages()) return false;
    if (e.key === 'Escape') return this.collapse();
    const move = moveOf(e);
    if (!move) return false;
    // Shift+keys move a selection's end, with or without the switch; the other keys need the switch (takesKeys).
    if (!(move.extend && this.host.selection() !== null) && !this.takesKeys()) return false;
    e.preventDefault();
    this.enqueue(() => this.run(move));
    return true;
  }

  /** Where a Shift+click extends from when nothing is selected: the caret, while the switch is on. */
  anchor(): CharPos | null {
    return this.on && this.pos ? { pageIndex: this.pos.pageIndex, charIndex: this.pos.charIndex } : null;
  }

  /** A plain click (no drag) at client point (x, y) with the switch on: the caret goes to the nearest place in the text. */
  click(x: number, y: number): void {
    if (!this.on) return;
    const hit = this.host.pageList()?.pdfPointAt(x, y);
    if (!hit) return;
    this.enqueue(async () => {
      this.goal = null;
      const p = await this.page(hit.pageIndex);
      if (p.stops.length === 0) {
        this.noteIfScan(hit.pageIndex);
        return;
      }
      const k = stopNear(p, hit.x, hit.y);
      if (k >= 0 && this.on && this.host.selection() === null) this.place(caretAt(p, hit.pageIndex, k), { scroll: false });
    });
  }

  /** Puts the caret at `at` with nothing selected (a Find hit): the view is not moved. Only with the switch on. */
  placeAt(at: CharPos & { side?: CaretPos['side'] }): void {
    if (!this.on) return;
    this.enqueue(async () => {
      this.goal = null;
      const r = await this.resolve({ side: 'before', ...at });
      if (r && this.on) this.place(r, { scroll: false, clear: true });
    });
  }

  /**
   * A page's glyphs were read (its text layer was built): with the switch on, its caret stops and its words are worked
   * out while the tab is idle, so the first key on that page has nothing to wait for.
   */
  warm(pageIndex: number): void {
    const g = this.host.cachedGlyphs(pageIndex);
    if (!this.on || !g || this.warmed.has(g)) return;
    this.warmed.add(g);
    if (g.glyphs.length === 0) {
      this.textless.add(pageIndex); // a scan: known at once, so the keys scroll there without waiting
      return;
    }
    const run = () => {
      if (pageCaret(g).stops.length === 0) this.textless.add(pageIndex);
      wordSegments(g);
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1000 });
    else setTimeout(run, 0);
  }

  /** A page was laid out (mounted, zoomed, turned): the caret is drawn again if it is on it. */
  pageShown(pageIndex: number): void {
    if (this.pos?.pageIndex === pageIndex) this.draw();
  }

  dispose(): void {
    this.offSelection();
    this.ac.abort();
    this.live?.remove();
    this.live = null;
  }

  // ---- moving ----

  /** Runs `f` after the moves before it (a move that waits for a page's glyphs keeps the keys in order). */
  private enqueue(f: () => Promise<void>): void {
    this.queue = this.queue.then(f).catch((err: unknown) => console.error('sickofpdfs: the text cursor could not move', err));
  }

  /** The page's caret stops (glyphs read first when they are not cached). */
  private async page(pageIndex: number): Promise<PageCaret> {
    return (await this.pageWithGlyphs(pageIndex)).p;
  }

  private async pageWithGlyphs(pageIndex: number): Promise<{ p: PageCaret; g: PageGlyphs }> {
    const g = this.host.cachedGlyphs(pageIndex) ?? (await this.host.glyphs(pageIndex));
    const p = pageCaret(g);
    if (p.stops.length === 0) this.textless.add(pageIndex);
    return { p, g };
  }

  private pageNow(pageIndex: number): PageCaret | null {
    const g = this.host.cachedGlyphs(pageIndex);
    return g ? pageCaret(g) : null;
  }

  /** A position snapped to a stop of its page; null when the page has no text. */
  private async resolve(at: CaretPos): Promise<CaretPos | null> {
    if (at.pageIndex < 0 || at.pageIndex >= this.host.pages.length) return null;
    const p = await this.page(at.pageIndex);
    const k = stopIndexOf(p, at.charIndex, at.side);
    return k < 0 ? null : caretAt(p, at.pageIndex, k);
  }

  /** The selection's focus as a caret: at the end of a line when the selection runs forward to it, else at a start. */
  private focusOf(s: TextSelection): CaretPos {
    return { ...s.focus, side: cmpPos(s.anchor, s.focus) < 0 ? 'after' : 'before' };
  }

  /** The next page from `from` in direction `dir` that has text, or −1 (none within `max` pages). */
  private async textPage(from: number, dir: 1 | -1, max = SKIP_PAGES_MAX): Promise<number> {
    for (let i = from + dir, n = 0; i >= 0 && i < this.host.pages.length && n < max; i += dir, n++) {
      if (!this.textless.has(i) && (await this.page(i)).stops.length > 0) return i;
      this.noteIfScan(i);
    }
    return -1;
  }

  /**
   * Where the caret starts when it has no place yet: the first line, in reading order, that is in view on the first page
   * in view that has text (on a page with no line in view, its first line).
   */
  private async startPos(): Promise<CaretPos | null> {
    const list = this.host.pageList();
    const el = this.host.scroller();
    if (!list || !el) return null;
    const boxes = list.pageBoxes();
    const view = { top: el.scrollTop + VIEW_MARGIN_TOP, bottom: el.scrollTop + el.clientHeight - VIEW_MARGIN, left: el.scrollLeft, right: el.scrollLeft + el.clientWidth };
    const inView = boxes.filter((b) => b.top < view.bottom && b.top + b.height > view.top && b.left < view.right && b.left + b.width > view.left);
    if (inView.length === 0) inView.push(boxes[Math.min(boxes.length - 1, Math.max(0, list.currentPage()))]);
    for (const box of inView) {
      if (!box || this.textless.has(box.index)) continue;
      const p = await this.page(box.index);
      if (p.stops.length === 0) {
        this.noteIfScan(box.index);
        continue;
      }
      const size = this.host.pages[box.index];
      const first = p.lines.find((l) => {
        const c = pagePointToContent(box, size, stopPoint(p.stops[l.firstStop], l.angle));
        return c.y >= view.top && c.y <= view.bottom && c.x >= view.left && c.x <= view.right;
      });
      return caretAt(p, box.index, first?.firstStop ?? 0);
    }
    const last = inView[inView.length - 1]?.index ?? 0;
    const q = await this.textPage(last, 1, START_PAGES_AFTER_VIEW);
    if (q < 0) return null;
    return caretAt(await this.page(q), q, 0);
  }

  private async run(move: Move): Promise<void> {
    if (!this.on && !this.host.selection()) return;
    const sel = this.host.selection();
    // The caret is at the selection's moving end. Its own side wins there: one char index can be both the end of a line
    // and the start of the next, and the caret knows which of the two it is on.
    const own = this.pos !== null && (!sel || (sel.focus.pageIndex === this.pos.pageIndex && sel.focus.charIndex === this.pos.charIndex));
    const from = own ? await this.resolve(this.pos!) : sel ? await this.resolve(this.focusOf(sel)) : null;
    if (!from) {
      // No caret yet: the first key puts it at the top of the view (and extends from there with Shift).
      const start = await this.startPos();
      if (!start) {
        this.noteNoText();
        this.scrollInstead(move);
        return;
      }
      if (!move.extend) {
        this.place(start, { clear: true });
        return;
      }
      this.pos = start;
    }
    const at = from ?? this.pos!;
    // ←/→ with text selected and no Shift: the caret goes to that end of the selection, as in a text editor.
    if (sel && !move.extend && move.kind === 'char') {
      const [lo, hi] = cmpPos(sel.anchor, sel.focus) <= 0 ? [sel.anchor, sel.focus] : [sel.focus, sel.anchor];
      const edge = await this.resolve(move.dir < 0 ? { ...lo, side: 'before' } : { ...hi, side: 'after' });
      if (edge) this.place(edge, { clear: true });
      return;
    }
    const vertical = move.kind === 'line';
    const to = await this.target(at, move);
    if (!vertical) this.goal = null;
    if (!to) return;
    if (move.extend) {
      const anchor = sel?.anchor ?? { pageIndex: at.pageIndex, charIndex: at.charIndex };
      const focus = { pageIndex: to.pageIndex, charIndex: to.charIndex };
      this.place(to, { select: { anchor, focus }, soon: move.repeat, screen: move.kind === 'screen' ? move.dir : 0 });
    } else {
      this.place(to, { clear: true, screen: move.kind === 'screen' ? move.dir : 0, docStart: move.kind === 'docEdge' && move.dir < 0 });
    }
  }

  /** Where `move` takes the caret from `at` (a stop), or null when it cannot go further. */
  private async target(at: CaretPos, move: Move): Promise<CaretPos | null> {
    const { dir } = move;
    const p = await this.page(at.pageIndex);
    const k = stopIndexOf(p, at.charIndex, at.side);
    const stop = p.stops[k];
    switch (move.kind) {
      case 'char': {
        const t = stepChar(p, k, dir);
        if (t >= 0) return caretAt(p, at.pageIndex, t);
        const q = await this.textPage(at.pageIndex, dir);
        if (q < 0) return null;
        const pq = await this.page(q);
        return caretAt(pq, q, dir > 0 ? 0 : pq.stops.length - 1);
      }
      case 'word': {
        const t = stepWord(p, (await this.pageWithGlyphs(at.pageIndex)).g, k, dir);
        if (t >= 0) return caretAt(p, at.pageIndex, t);
        const q = await this.textPage(at.pageIndex, dir);
        if (q < 0) {
          // No word before it in the PDF: the very start (Ctrl+←); after the last word: the very end (Ctrl+→).
          const edge = dir > 0 ? p.stops.length - 1 : 0;
          return edge === k ? null : caretAt(p, at.pageIndex, edge);
        }
        const { p: pq, g: gq } = await this.pageWithGlyphs(q);
        if (dir > 0) {
          const first = wordSegments(gq).find((w) => w.wordLike && w.start >= 0);
          return caretAt(pq, q, first ? stopIndexOf(pq, first.start, 'before') : 0);
        }
        const last = pq.stops.length - 1;
        const t2 = stepWord(pq, gq, last, -1);
        return caretAt(pq, q, t2 >= 0 ? t2 : 0);
      }
      case 'line': {
        this.goal ??= stopPoint(stop, p.lines[stop.line].angle);
        const goal = this.goal;
        const line = stop.line + dir;
        if (line >= 0 && line < p.lines.length) return caretAt(p, at.pageIndex, stopOnLine(p, line, goal.x, goal.y));
        const q = await this.textPage(at.pageIndex, dir);
        if (q < 0) return null;
        const pq = await this.page(q);
        return caretAt(pq, q, stopOnLine(pq, dir > 0 ? 0 : pq.lines.length - 1, goal.x, goal.y));
      }
      case 'lineEdge': {
        const l = p.lines[stop.line];
        return caretAt(p, at.pageIndex, dir < 0 ? l.firstStop : l.firstStop + l.stops.length - 1);
      }
      case 'docEdge': {
        const q = dir < 0 ? await this.textPage(-1, 1) : await this.textPage(this.host.pages.length, -1);
        if (q < 0) return null;
        const pq = await this.page(q);
        return caretAt(pq, q, dir < 0 ? 0 : pq.stops.length - 1);
      }
      case 'screen':
        return this.screenTarget(at, p, k, dir);
    }
  }

  /** Page Up / Page Down: the place a screen above or below the caret, nearest to where the caret is across the page. */
  private async screenTarget(at: CaretPos, p: PageCaret, k: number, dir: 1 | -1): Promise<CaretPos | null> {
    const list = this.host.pageList();
    const el = this.host.scroller();
    const boxes = list?.pageBoxes() ?? [];
    const box = boxes[at.pageIndex];
    if (!list || !el || !box) return null;
    const stop = p.stops[k];
    const size = this.host.pages[at.pageIndex];
    const here = pagePointToContent(box, size, stopPoint(stop, p.lines[stop.line].angle));
    const want = { x: here.x, y: here.y + dir * Math.max(el.clientHeight - SCREEN_OVERLAP_PX, SCREEN_OVERLAP_PX) };
    // The page under that point, or the nearest one in the direction of the move.
    let index = boxes.findIndex((b) => want.y >= b.top && want.y <= b.top + b.height && want.x >= b.left && want.x <= b.left + b.width);
    if (index < 0) index = boxes.findIndex((b) => want.y >= b.top && want.y <= b.top + b.height);
    if (index < 0) {
      // Between pages, or past the first or last: the nearest page that way.
      index = dir > 0 ? boxes.findIndex((b) => b.top >= want.y) : boxes.findLastIndex((b) => b.top + b.height <= want.y);
      if (index < 0) index = dir > 0 ? boxes.length - 1 : 0;
    }
    let pq = await this.page(index);
    if (pq.stops.length === 0) {
      this.noteIfScan(index);
      const q = await this.textPage(index, dir);
      if (q < 0) return null;
      pq = await this.page(q);
      return caretAt(pq, q, dir > 0 ? 0 : pq.stops.length - 1);
    }
    const w = contentPointToPage(boxes[index], this.host.pages[index], want);
    const k2 = stopNear(pq, w.x, w.y);
    const to = caretAt(pq, index, k2);
    return to.pageIndex === at.pageIndex && to.charIndex === at.charIndex ? (dir > 0 ? caretAt(pq, index, pq.stops.length - 1) : caretAt(pq, index, 0)) : to;
  }

  /** When the caret cannot be placed (no text near the view), the key does what it does without the switch. */
  private scrollInstead(move: Move): void {
    const a = this.host.pageList();
    if (!a) return;
    switch (move.key) {
      case 'ArrowDown':
        return a.scrollLines(1);
      case 'ArrowUp':
        return a.scrollLines(-1);
      case 'ArrowRight':
        return a.scrollSideways(1);
      case 'ArrowLeft':
        return a.scrollSideways(-1);
      case 'PageDown':
        return a.scrollScreens(1);
      case 'PageUp':
        return a.scrollScreens(-1);
      case 'Home':
        return a.goToStart();
      case 'End':
        return a.goToEnd();
    }
  }

  /** Esc with text selected: the selection goes, and the caret stays at its moving end. */
  private collapse(): boolean {
    const sel = this.host.selection();
    if (!sel) return false;
    this.enqueue(async () => {
      this.goal = null;
      const own = this.pos !== null && sel.focus.pageIndex === this.pos.pageIndex && sel.focus.charIndex === this.pos.charIndex;
      const at = await this.resolve(own ? this.pos! : this.focusOf(sel));
      if (at) this.place(at, { clear: true, scroll: false, tell: false });
      else this.host.select(null);
    });
    return true; // Esc is not prevented: a note or a figure may let go on the same key
  }

  /**
   * Puts the caret at `to`: the selection is set (`select`) or cleared (`clear`), the caret drawn, the view scrolled to
   * keep it in sight (by a screen first for Page Up/Down) and its line told to a screen reader.
   */
  private place(
    to: CaretPos,
    o: { select?: TextSelection; soon?: boolean; clear?: boolean; scroll?: boolean; tell?: boolean; screen?: number; docStart?: boolean } = {},
  ): void {
    this.pos = to;
    if (o.select || (o.clear && this.host.selection())) {
      this.selecting = true;
      try {
        this.host.select(o.select ?? null, o.soon === true);
      } finally {
        this.selecting = false;
      }
    }
    // Neighbouring pages are read ahead, so the next move across a page edge needs no wait.
    for (const i of [to.pageIndex - 1, to.pageIndex, to.pageIndex + 1]) {
      if (i < 0 || i >= this.host.pages.length || this.textless.has(i)) continue;
      if (this.host.cachedGlyphs(i)) this.warm(i);
      else
        this.host.glyphs(i).then(
          () => this.warm(i),
          () => {},
        );
    }
    // The view is measured before anything is drawn, so no layout is forced in between.
    if (o.scroll !== false) this.reveal(to, o.screen ?? 0, o.docStart === true);
    this.draw();
    if (o.tell !== false) this.tell(to);
  }

  /** Someone else changed the selection (a drag, a double-click, Find, Ctrl+A): the caret goes to its moving end. */
  private onSelectionChange(): void {
    if (this.selecting) return;
    const sel = this.host.selection();
    if (!sel) return; // cleared (a mark made from it, a click): the caret stays where it was
    this.goal = null;
    this.pos = this.focusOf(sel);
    const p = this.pageNow(this.pos.pageIndex);
    if (p) {
      const k = stopIndexOf(p, this.pos.charIndex, this.pos.side);
      if (k >= 0) this.pos = caretAt(p, this.pos.pageIndex, k);
    }
    this.draw();
  }

  // ---- drawing, scrolling, telling ----

  /** Every page in view is known to have no text. */
  private viewHasNoText(): boolean {
    const list = this.host.pageList();
    const el = this.host.scroller();
    if (!list || !el) return false;
    const top = el.scrollTop;
    const bottom = top + el.clientHeight;
    const inView = list.pageBoxes().filter((b) => b.top < bottom && b.top + b.height > top);
    return inView.length > 0 && inView.every((b) => this.textless.has(b.index));
  }

  /** Keys and drawing are for the pages: the focus is on them (or nowhere), not in a field, a menu or a dialog. */
  private inPages(): boolean {
    const a = document.activeElement;
    const root = this.host.scroller();
    return a === null || a === document.body || a === document.documentElement || (root !== null && root.contains(a));
  }

  /** Draws the caret on its page (and nowhere else), or hides it. */
  private draw(): void {
    const pos = this.on ? this.pos : null;
    const m = pos ? this.host.mounted(pos.pageIndex) : null;
    const el = m?.caret ?? null;
    if (this.shownOn && this.shownOn !== el) this.shownOn.hidden = true;
    this.shownOn = el;
    if (!pos || !m || !el) return;
    const p = this.pageNow(pos.pageIndex);
    const k = p ? stopIndexOf(p, pos.charIndex, pos.side) : -1;
    if (!p || k < 0 || !this.inPages()) {
      el.hidden = true;
      return;
    }
    const stop = p.stops[k];
    const size = this.host.pages[pos.pageIndex];
    const s = stopSegment(stop, p.lines[stop.line].angle);
    const scale = cssPerPoint(m.box, size);
    const a = pageToDisplayed(s.x0, s.y0, m.box.rotation, size.width, size.height);
    const b = pageToDisplayed(s.x1, s.y1, m.box.rotation, size.width, size.height);
    let x0 = a.x * scale;
    let y0 = a.y * scale;
    const dx = (b.x - a.x) * scale;
    const dy = (b.y - a.y) * scale;
    // A bar from (x0, y0), its length along its own y axis, turned to point at the other end; centred on the line.
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI - 90;
    // An upright or sideways bar's sides go on whole device pixels, so it is a solid 2 px bar, not a smudge over three.
    [x0, y0] = snapToDevice(el, x0, y0, angle);
    el.style.height = `${Math.hypot(dx, dy).toFixed(2)}px`;
    el.style.transform = `translate(${x0.toFixed(2)}px, ${y0.toFixed(2)}px) rotate(${angle.toFixed(3)}deg) translateX(-50%)`;
    el.hidden = false;
    // Solid again from this moment, then blinking (reduced motion: no animation at all): a new animation name starts
    // the blink over, without asking the browser for its animations (which would bring its styles up to date first).
    el.classList.toggle('sop-caret-again');
  }

  /**
   * Scrolls the view so the caret is in sight (first by `screen` views, for Page Up/Down; to the top of the PDF for
   * Ctrl+Home, `docStart`); smooth unless the reader asked for reduced motion.
   */
  private reveal(at: CaretPos, screen: number, docStart = false): void {
    const list = this.host.pageList();
    const el = this.host.scroller();
    const box = list?.pageBoxes()[at.pageIndex];
    const p = this.pageNow(at.pageIndex);
    if (!el || !box || !p) return;
    const k = stopIndexOf(p, at.charIndex, at.side);
    if (k < 0) return;
    const stop = p.stops[k];
    const size = this.host.pages[at.pageIndex];
    const s = stopSegment(stop, p.lines[stop.line].angle);
    const a = pagePointToContent(box, size, { x: s.x0, y: s.y0 });
    const b = pagePointToContent(box, size, { x: s.x1, y: s.y1 });
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    const maxTop = el.scrollHeight - el.clientHeight;
    let top = Math.min(maxTop, Math.max(0, el.scrollTop + screen * Math.max(el.clientHeight - SCREEN_OVERLAP_PX, SCREEN_OVERLAP_PX)));
    let left = el.scrollLeft;
    if (y0 < top + VIEW_MARGIN_TOP) top = y0 - VIEW_MARGIN_TOP;
    else if (y1 > top + el.clientHeight - VIEW_MARGIN) top = y1 - el.clientHeight + VIEW_MARGIN;
    if (docStart && at.pageIndex === 0) top = 0;
    if (x0 < left + VIEW_MARGIN) left = x0 - VIEW_MARGIN;
    else if (x1 > left + el.clientWidth - VIEW_MARGIN) left = x1 - el.clientWidth + VIEW_MARGIN;
    top = Math.round(Math.min(maxTop, Math.max(0, top)));
    left = Math.round(Math.max(0, left));
    if (top === el.scrollTop && left === el.scrollLeft) return;
    el.scrollTo({ top, left, behavior: reducedMotion() ? 'instant' : 'smooth' });
  }

  /** Tells a screen reader the caret's line, once per line it moves to (never letter by letter). */
  private tell(at: CaretPos): void {
    const p = this.pageNow(at.pageIndex);
    const k = p ? stopIndexOf(p, at.charIndex, at.side) : -1;
    if (!p || k < 0) return;
    const key = `${at.pageIndex}:${p.stops[k].line}`;
    if (key === this.toldLine) return;
    const newPage = this.toldLine.split(':')[0] !== String(at.pageIndex);
    this.toldLine = key;
    const text = lineTextOf(p, k);
    const live = this.liveRegion();
    // The same words twice in a row would not be read again: a zero-width space tells the two apart.
    const next = `${newPage ? `Page ${at.pageIndex + 1}. ` : ''}${text}`;
    live.textContent = live.textContent === next ? `${next}\u200b` : next;
  }

  private liveRegion(): HTMLElement {
    if (this.live?.isConnected) return this.live;
    const el = document.createElement('div');
    el.className = 'sop-caret-live';
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    // Read, not seen (the usual visually-hidden box).
    Object.assign(el.style, { position: 'fixed', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap', margin: '-1px', padding: '0', border: '0' });
    document.body.append(el);
    this.live = el;
    return el;
  }

  /** No text near the view for the caret (a scanned PDF): said once per tab, and the keys scroll as before. */
  private noteNoText(): void {
    if (scanNoteShown) return;
    scanNoteShown = true;
    this.host.note?.(CARET_SCAN_NOTE);
  }

  /** R93's quiet note, once per tab, the first time the caret meets a scanned page. */
  private noteIfScan(pageIndex: number): void {
    const isScan = this.host.isScannedPage;
    if (scanNoteShown || !isScan || !this.host.note) return;
    isScan(pageIndex).then(
      (scan) => {
        if (!scan || scanNoteShown) return;
        scanNoteShown = true;
        this.host.note?.(CARET_SCAN_NOTE);
      },
      () => {},
    );
  }
}

/**
 * The caret's start (x0, y0), in its page layer's CSS px, moved by under a device pixel so that a bar turned by `angle`
 * (a multiple of 90°: upright or sideways text) and centred on it (translateX(-50%)) has its sides on whole device
 * pixels. Any other angle is left as it is.
 */
function snapToDevice(el: HTMLElement, x0: number, y0: number, angle: number): [number, number] {
  const turn = ((Math.round(angle) % 360) + 360) % 360;
  if (Math.abs(angle - Math.round(angle)) > 0.01 || turn % 90 !== 0) return [x0, y0];
  const layer = el.offsetParent ?? el.parentElement;
  if (!layer) return [x0, y0];
  const dpr = globalThis.devicePixelRatio || 1;
  const at = layer.getBoundingClientRect();
  const half = el.offsetWidth / 2;
  // The side the bar's width lies across: x for an upright bar, y for a sideways one.
  if (turn % 180 === 0) return [Math.round((at.left + x0 - half) * dpr) / dpr - at.left + half, y0];
  return [x0, Math.round((at.top + y0 - half) * dpr) / dpr - at.top + half];
}
