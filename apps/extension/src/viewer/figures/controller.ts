// Figures, areas and pins in the viewer (Phase 2, S16; spec "Figures and areas", research 06 section 4).
//
// What the person does, and what happens:
// - Rest the pointer on a figure: a faint outline, within 100 ms, drawn from the figures already found (figure
//   detection runs at idle after each page's full render and never delays drawing one). Medium-confidence figures show
//   too while Alt is held.
// - Click a figure (no drag, not on a link): it is selected, with a solid 2 px outline. A drag still selects text, so
//   axis labels stay selectable. Esc, or a click on empty page, lets it go.
// - Ctrl+Alt+M with a figure selected: a note on the figure, with no highlight (the figure's outline is its mark). With
//   nothing selected and the pointer over a figure: a numbered pin there. A second Ctrl+Alt+M on a figure that has a
//   note opens that note.
// - Right-click a figure: Comment and Copy image (Ask Claude and Explain this figure join in Phase 4). Ctrl+C copies the
//   selected figure as a PNG drawn at 2×, on this computer.
// - Alt+drag anywhere (links are ignored while Alt is held), on scans too: an area mark, which is then the focused mark,
//   so Ctrl+Alt+M comments on it, Ctrl+C copies it and Delete removes it. Inside a figure, a note on that area is a part
//   of the figure (stored relative to it). Alt+click selects any figure under the pointer, medium ones included.
// - The area tool (toolbar, Tools menu): the next plain drag draws a rectangle and opens a note on it at once.
//
// Notes go through the comments feature (S14): Ctrl+Alt+M reads `noteTarget` first (notes-bridge.ts), so the note box,
// the margin and "no lost text" are the ones text notes use. Incognito has no notes, and so none of this (wire.ts).
import type { MarkId, NormRect } from '@sop/core';
import { contentPointToPage, type PageSize } from '@sop/viewer';
import type { FigureLayerNote, FigureLayerPage, FigureLayerSource } from '@sop/viewer/react';
import type { CommandBehaviour, ViewerCommandId } from '../commands';
import { overlayOpen } from '../annotations/mark-input';
import type { NotesHost } from '../annotations/wire';
import { noteCommands } from '../notes/notes-host';
import { installShortcuts, isTypingTarget } from '../shortcuts';
import {
  type AreaAnchor,
  contains,
  type FigureAnchor,
  figureAnchor,
  figureAround,
  figureAt,
  type FoundFigure,
  noteOnPlace,
  notePlace,
  ordered,
  placedAnchor,
  relativePoint,
  relativeRect,
  sameFigure,
  sameRect,
} from './anchors';
import { copyRegion, createThumbnailCache, regionPng, type ThumbnailCache } from './images';
import { setSpecialNoteTarget, type SpecialNote } from './notes-bridge';

/** What Ctrl+Alt+M, Ctrl+C and the figure menu act on: the selected figure, or the focused area mark. */
export type Region = { kind: 'figure'; found: FoundFigure } | { kind: 'area'; markId: MarkId; page: number; rect: NormRect; dHash: string };

export interface FigureState {
  /** The figure under the pointer. */
  hover: FoundFigure | null;
  selected: FoundFigure | null;
  /** The rectangle being drawn. */
  drawing: { page: number; rect: NormRect } | null;
  /** The area tool is on: the next plain drag draws an area note. */
  areaTool: boolean;
  /** The figure menu, open at a viewport point. */
  menu: { at: { x: number; y: number }; region: Region } | null;
}

export interface FigureController {
  readonly host: NotesHost;
  state(this: void): FigureState;
  subscribe(this: void, cb: () => void): () => void;
  /** What each page's FigureLayer draws. */
  readonly layer: FigureLayerSource;
  readonly thumbnails: ThumbnailCache;
  /** Starts listening to the pointer and the keys; returns the stop. */
  attach(): () => void;
  /** Whether it is listening (attach was called and not stopped). */
  attached(): boolean;
  /** A page's full render is on screen (its figures are then found at idle). */
  pagePainted(page: number): void;
  select(f: FoundFigure | null): void;
  region(): Region | null;
  behaviours(): Partial<Record<ViewerCommandId, CommandBehaviour>>;
  /** Comment on a region (the menu's Comment): opens its note, or the note it has. */
  comment(r: Region): void;
  /** Copy image. */
  copy(r: Region): void;
  /** Takes an area mark off. */
  removeArea(id: MarkId): void;
  closeMenu(this: void): void;
  setAreaTool(on: boolean): void;
  /** Whether notes can be made here (not view only). */
  editable(): boolean;
  dispose(): void;
}

/** A press that moves less than this (CSS px) is a click. */
const CLICK_SLOP_PX = 4;
/** A drawn rectangle smaller than this on either side (CSS px) is a click, not an area. */
const MIN_AREA_PX = 6;
/** The contextmenu event this soon after the menu key opened our menu is that key's own, and is ignored. */
const KEY_MENU_MS = 800;
/** A drawn rectangle stays on screen until its mark or note appears, at most this long. */
const DRAWING_HOLD_MS = 3000;
/** The figure is copied with this much of the page round it (points), so anti-aliased edges are not cut. */
const COPY_PAD_PT = 2;

const EMPTY_PAGE: FigureLayerPage = { hover: null, selected: null, notes: [], drawing: null };

/** The tool's state for the toolbar button (one viewer tab shows one document). */
const toolListeners = new Set<() => void>();
let toolOn = false;
export function areaToolOn(): boolean {
  return toolOn;
}
export function subscribeAreaTool(cb: () => void): () => void {
  toolListeners.add(cb);
  return () => toolListeners.delete(cb);
}
function setToolOn(on: boolean): void {
  if (toolOn === on) return;
  toolOn = on;
  for (const l of [...toolListeners]) l();
}

function scroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="document"]');
}

function dialogOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]') !== null;
}

/** Parts of the viewer over the pages that take their own clicks: cards, pins, buttons and fields. */
function ownClick(t: EventTarget | null): boolean {
  return t instanceof Element && t.closest('[id^="note-card-"], [data-note-pin], [data-figure-pin], button, textarea, input, [role="menu"]') !== null;
}

export function createFigureController(host: NotesHost): FigureController {
  const { session, pages } = host;
  const thumbnails = createThumbnailCache();
  let st: FigureState = { hover: null, selected: null, drawing: null, areaTool: false, menu: null };
  const listeners = new Set<() => void>();
  let version = 0;
  /** A note Ctrl+Alt+M is about to make (the menu's Comment, the area tool), read once by noteTarget. */
  let pending: SpecialNote | null = null;
  /** The anchors of whole figures, made once (they need a dHash render and the page's text). */
  const anchors = new Map<string, Promise<FigureAnchor>>();
  /** The hover outline's speed mark: when the pointer reached the figure. */
  let outlineTiming: { t0: number; page: number } | null = null;
  let keyMenuAt = -Infinity;
  let disposed = false;

  /** A polite live region while attached: what is selected, and which keys act on it. */
  let live: HTMLElement | null = null;

  const emit = () => {
    version++;
    for (const l of [...listeners]) l();
  };
  const set = (patch: Partial<FigureState>) => {
    st = { ...st, ...patch };
    emit();
  };

  const editable = () => !disposed && session.state().mode !== 'view-only';
  const sizeOf = (page: number): PageSize | undefined => pages[page];
  const peek = (page: number) => host.figures.peek(page);

  /** The page point under a client point, as 0–1 of the page. */
  function pointAt(x: number, y: number): { page: number; u: number; v: number } | null {
    const p = host.pageList.current?.pdfPointAt(x, y);
    const size = p ? sizeOf(p.pageIndex) : undefined;
    if (!p || !size) return null;
    return { page: p.pageIndex, u: p.x / size.width, v: p.y / size.height };
  }

  /** The area mark under a page point (the topmost, the last drawn), with its anchor as placed here. */
  function areaMarkAt(page: number, u: number, v: number): Extract<Region, { kind: 'area' }> | null {
    const s = session.state();
    for (let i = s.marks.length - 1; i >= 0; i--) {
      const m = s.marks[i];
      if (m?.style !== 'area') continue;
      const r = s.placement.get(m.id);
      const a = r?.placed === true ? r.anchor : null;
      if (a?.kind === 'area' && a.page === page && contains(a.rect, u, v, 0.002)) return { kind: 'area', markId: m.id, page, rect: a.rect, dHash: a.dHash };
    }
    return null;
  }

  function region(): Region | null {
    if (st.selected !== null) return { kind: 'figure', found: st.selected };
    const s = session.state();
    const id = s.focusedMark;
    const m = id === null ? undefined : s.marks.find((x) => x.id === id);
    if (!m || m.style !== 'area') return null;
    const r = s.placement.get(m.id);
    const a = r?.placed === true ? r.anchor : null;
    return a?.kind === 'area' ? { kind: 'area', markId: m.id, page: a.page, rect: a.rect, dHash: a.dHash } : null;
  }

  // ---------------------------------------------------------------- anchors for notes

  const anchorDeps = {
    dHash: (page: number, rect: NormRect) => host.figures.dHash(page, rect),
    rawText: (page: number) => host.pageText.rawText(page),
  };

  /** The whole figure's anchor, made once and kept (it is warmed when the figure is selected). */
  function wholeFigure(f: FoundFigure): Promise<FigureAnchor> {
    const key = `${f.page}|${f.figure.index}|${f.rect.join(',')}`;
    let a = anchors.get(key);
    if (!a) {
      a = figureAnchor(f, anchorDeps);
      anchors.set(key, a);
    }
    return a.then((x) => structuredClone(x));
  }

  /** Where the pages keep still while the margin opens: the top-left of the region, on screen. */
  function keepPoint(page: number, rect: NormRect): { clientX: number; clientY: number } | undefined {
    const size = sizeOf(page);
    const at = size ? host.pageList.current?.clientPointOf({ pageIndex: page, x: rect[0] * size.width, y: rect[1] * size.height }) : undefined;
    return at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { clientX: at.x, clientY: at.y } : undefined;
  }

  /** The note for a region: the one it has, or a new one on the figure, on a part of a figure, or on the area. */
  function noteFor(r: Region): SpecialNote {
    const s = session.state();
    if (r.kind === 'figure') {
      const f = r.found;
      const had = noteOnPlace(s.threads, s.placement, f.page, f.rect);
      return had !== null ? { kind: 'existing', threadId: had } : { kind: 'new', anchor: () => wholeFigure(f), ...withKeep(keepPoint(f.page, f.rect)) };
    }
    const had = noteOnPlace(s.threads, s.placement, r.page, r.rect);
    if (had !== null) return { kind: 'existing', threadId: had };
    return { kind: 'new', anchor: areaNoteAnchor(r.page, r.rect, r.dHash), ...withKeep(keepPoint(r.page, r.rect)) };
  }

  /** The note for a region, which then stops being selected: its outline and card take its place, as a text note's highlight does. */
  function noteReleasing(r: Region): SpecialNote {
    const note = noteFor(r);
    if (r.kind === 'figure') select(null);
    else if (session.state().focusedMark === r.markId) session.setFocusedMark(null);
    return note;
  }

  /** A rectangle's note: the whole figure when it is the figure, a part of the figure inside one, else an area. */
  function areaNoteAnchor(page: number, rect: NormRect, dHash: string | null): () => Promise<FigureAnchor | AreaAnchor> {
    const around = figureAround(peek(page), page, sizeOf(page), rect);
    if (around && sameRect(around.rect, rect, 0.9)) return () => wholeFigure(around);
    if (around) return () => figureAnchor(around, anchorDeps, { rect: relativeRect(around.rect, rect) });
    return async () => ({ kind: 'area', page, rect: [...rect], dHash: dHash ?? (await host.figures.dHash(page, rect).catch(() => '')) });
  }

  /** What Ctrl+Alt+M is about, when it is not the selected text (S14 reads this first; null leaves it to the text flow). */
  function noteTarget(): SpecialNote | null {
    if (pending !== null) {
      const p = pending;
      pending = null;
      return p;
    }
    if (!editable() || host.textSelection.ranges().length > 0) return null;
    const r = region();
    if (r !== null) return noteReleasing(r);
    // Nothing selected, the pointer over a figure: a pin there.
    const at = host.pointer();
    const p = at ? pointAt(at.x, at.y) : null;
    const f = p ? figureAt(peek(p.page), p.page, sizeOf(p.page), p.u, p.v) : null;
    if (!at || !p || !f) return null;
    const point = relativePoint(f.rect, p.u, p.v);
    return { kind: 'new', anchor: () => figureAnchor(f, anchorDeps, { point }), keep: { clientX: at.x, clientY: at.y } };
  }

  /** Runs Ctrl+Alt+M on a note decided here (the menu's Comment, the area tool). */
  function runComment(note: SpecialNote): void {
    const cmd = noteCommands()?.['marks.comment'];
    if (!cmd || !cmd.enabled()) return;
    pending = note;
    cmd.run();
    pending = null;
  }

  // ---------------------------------------------------------------- selecting

  function announce(text: string): void {
    if (live) live.textContent = text;
  }

  function select(f: FoundFigure | null): void {
    if (sameFigure(f, st.selected)) return;
    if (f !== null) {
      if (session.state().focusedMark !== null) session.setFocusedMark(null);
      if (host.textSelection.ranges().length > 0) host.textSelection.clear();
      void wholeFigure(f).catch(() => {}); // ready by the time Ctrl+Alt+M is pressed
      const name = f.figure.label ?? 'Figure';
      announce(`${name} on page ${f.page + 1} selected. Ctrl+Alt+M comments on it, Ctrl+C copies it, Esc lets go.`);
    } else if (st.selected !== null) announce('');
    set({ selected: f, hover: f !== null && sameFigure(st.hover, f) ? null : st.hover });
  }

  function setHover(f: FoundFigure | null, t0: number): void {
    if (sameFigure(f, st.hover)) return;
    outlineTiming = f !== null && !sameFigure(f, st.selected) ? { t0, page: f.page } : null;
    set({ hover: f });
  }

  // ---------------------------------------------------------------- copying

  function copy(r: Region): void {
    const page = r.kind === 'figure' ? r.found.page : r.page;
    const size = sizeOf(page);
    if (!size) return;
    let rect = r.kind === 'figure' ? r.found.rect : r.rect;
    if (r.kind === 'figure') {
      const px = COPY_PAD_PT / size.width;
      const py = COPY_PAD_PT / size.height;
      rect = ordered([rect[0] - px, rect[1] - py, rect[2] + px, rect[3] + py]);
    }
    const rotation = host.view.get().viewRotation;
    void copyRegion(() => regionPng(host.backend, host.doc, page, size, rect, rotation)).then((ok) =>
      host.showNote(ok ? 'Image copied' : 'Couldn’t copy the image. Try again.'),
    );
  }

  // ---------------------------------------------------------------- drawing areas

  interface Drag {
    page: number;
    u0: number;
    v0: number;
    x0: number;
    y0: number;
    pointerId: number;
    moved: boolean;
    /** The area tool started it (a note opens), not Alt (a mark is made). */
    tool: boolean;
    alt: boolean;
  }
  let drag: Drag | null = null;
  let press: { x: number; y: number } | null = null;
  let swallowClick = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let offHold: (() => void) | null = null;

  /** The page point (0–1) for a client point, on the drag's page, clipped to it. */
  function onDragPage(d: Drag, x: number, y: number): [number, number] {
    const el = scroller();
    const box = host.pageList.current?.pageBoxes()[d.page];
    const size = sizeOf(d.page);
    if (!el || !box || !size) return [d.u0, d.v0];
    const r = el.getBoundingClientRect();
    const p = contentPointToPage(box, size, { x: x - r.left + el.scrollLeft, y: y - r.top + el.scrollTop });
    const c = (v: number) => Math.min(1, Math.max(0, v));
    return [c(p.x / size.width), c(p.y / size.height)];
  }

  /** The rect's size on screen, CSS px. */
  function screenSize(page: number, rect: NormRect): { w: number; h: number } {
    const box = host.pageList.current?.pageBoxes()[page];
    if (!box) return { w: 0, h: 0 };
    const sideways = box.rotation % 180 !== 0;
    const pw = sideways ? box.height : box.width;
    const ph = sideways ? box.width : box.height;
    return { w: (rect[2] - rect[0]) * pw, h: (rect[3] - rect[1]) * ph };
  }

  /** Keeps the drawn rectangle on screen until `done()` says its mark or note is there (or a moment has passed). */
  function holdDrawing(done: () => boolean): void {
    clearHold();
    const check = () => {
      if (!done()) return;
      clearHold();
      set({ drawing: null });
    };
    offHold = session.subscribe(check);
    holdTimer = setTimeout(() => {
      clearHold();
      set({ drawing: null });
    }, DRAWING_HOLD_MS);
    check();
  }
  function clearHold(): void {
    offHold?.();
    offHold = null;
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
  }

  function finishDrawing(d: Drag, rect: NormRect): void {
    const { page } = d;
    if (d.tool) {
      setAreaTool(false);
      const had = noteOnPlace(session.state().threads, session.state().placement, page, rect);
      // Until the note's own outline is drawn (its anchor is made first: a dHash, and a caption inside a figure).
      holdDrawing(() => {
        const s = session.state();
        return s.threads.some((t) => {
          const place = notePlace(placedAnchor(t, s.placement.get(t.id)));
          return place !== null && place.page === page && sameRect(place.rect, rect, 0.98);
        });
      });
      runComment(had !== null ? { kind: 'existing', threadId: had } : { kind: 'new', anchor: areaNoteAnchor(page, rect, null), ...withKeep(keepPoint(page, rect)) });
      return;
    }
    // Alt+drag: an area mark, focused once it is there.
    const t0 = Date.now() - 1;
    const isOurs = (m: ReturnType<typeof session.state>['marks'][number]) =>
      m.style === 'area' && m.anchor.kind === 'area' && m.anchor.page === page && m.createdAt >= t0 && sameRect(m.anchor.rect, rect, 0.999);
    holdDrawing(() => {
      const m = session.state().marks.find(isOurs);
      if (m && session.state().focusedMark !== m.id) session.setFocusedMark(m.id);
      return m !== undefined;
    });
    void host.figures
      .dHash(page, rect)
      .catch(() => '')
      .then((dHash) => session.addAreaMark({ kind: 'area', page, rect, dHash }))
      .catch(() => set({ drawing: null }));
  }

  function setAreaTool(on: boolean): void {
    if (on && !editable()) return;
    setToolOn(on);
    if (st.areaTool !== on) set({ areaTool: on });
    crosshair();
  }

  let altHeld = false;
  /** The crosshair while a rectangle can be drawn: the area tool is on, or Alt is held over the pages. */
  function crosshair(): void {
    const el = scroller();
    if (el) el.toggleAttribute('data-sop-crosshair', editable() && (st.areaTool || altHeld || drag !== null));
  }

  // ---------------------------------------------------------------- the pointer and the keys

  let attachedCount = 0;
  /** Where the pointer rests on a page, for an outline whose figures arrive after it got there. */
  let lastPointer: { page: number; u: number; v: number; alt: boolean; t: number } | null = null;
  /** Pages whose full render is on screen, and the ones whose figures were asked for at once. */
  const painted = new Set<number>();
  const asked = new Set<number>();

  /** The page has had its full render: its figures are found at idle (figure detection never delays drawing a page). */
  function pagePainted(page: number): void {
    painted.add(page);
    host.figures.pageRendered(page);
  }

  /**
   * The pointer rests on a drawn page whose figures are not known yet (idle time is short on a busy machine): they are
   * found now. The page is on screen already, so this delays no drawing of it; other renders are served between the
   * engine calls.
   */
  function findNow(page: number): void {
    if (!painted.has(page) || asked.has(page)) return;
    asked.add(page);
    host.figures.figures(page).catch(() => asked.delete(page));
  }

  function attach(): () => void {
    attachedCount++;
    const ac = new AbortController();
    const signal = ac.signal;
    const liveEl = document.createElement('div');
    liveEl.setAttribute('role', 'status');
    liveEl.setAttribute('aria-live', 'polite');
    Object.assign(liveEl.style, { position: 'fixed', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' });
    document.body.appendChild(liveEl);
    live = liveEl;
    const offSession = session.subscribe(() => {
      // A mark focused elsewhere (a click on a mark, Tab) takes over from the selected figure.
      if (session.state().focusedMark !== null && st.selected !== null) set({ selected: null });
      else emit();
    });
    const offSelection = host.textSelection.subscribe(() => {
      if (host.textSelection.ranges().length > 0 && st.selected !== null) set({ selected: null });
    });
    const inScroller = (t: EventTarget | null) => t instanceof Node && scroller()?.contains(t) === true;

    window.addEventListener(
      'pointermove',
      (e) => {
        if (drag !== null && e.pointerId === drag.pointerId) {
          const [u, v] = onDragPage(drag, e.clientX, e.clientY);
          if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) >= CLICK_SLOP_PX) drag.moved = true;
          if (drag.moved) set({ drawing: { page: drag.page, rect: ordered([drag.u0, drag.v0, u, v]) } });
          return;
        }
        if (e.altKey !== altHeld) {
          altHeld = e.altKey;
          crosshair();
        }
        if (e.buttons !== 0 || !inScroller(e.target)) {
          lastPointer = null;
          setHover(null, e.timeStamp);
          return;
        }
        const p = pointAt(e.clientX, e.clientY);
        lastPointer = p === null ? null : { ...p, alt: e.altKey, t: e.timeStamp };
        if (p !== null && peek(p.page) === undefined) findNow(p.page);
        setHover(p ? figureAt(peek(p.page), p.page, sizeOf(p.page), p.u, p.v, e.altKey) : null, e.timeStamp);
      },
      { signal, passive: true },
    );
    document.documentElement.addEventListener(
      'pointerleave',
      (e) => {
        lastPointer = null;
        setHover(null, e.timeStamp);
      },
      { signal },
    );
    // A page's figures arrived while the pointer rests on it: its outline shows now (timed from the pointer's arrival).
    const offFigures = host.figures.subscribe((page) => {
      const lp = lastPointer;
      if (lp === null || lp.page !== page || drag !== null) return;
      setHover(figureAt(peek(page), page, sizeOf(page), lp.u, lp.v, lp.alt), lp.t);
    });

    // Before the text layer (a document listener) and the links: Alt+drag and the area tool draw instead of selecting.
    window.addEventListener(
      'pointerdown',
      (e) => {
        press = null;
        if (e.button !== 0 || !inScroller(e.target)) return;
        const t = e.target instanceof Element ? e.target : null;
        if (t?.closest('[id^="note-card-"], [data-note-pin], [data-figure-pin], textarea, input') != null) return;
        if (st.menu !== null) set({ menu: null });
        const draws = (e.altKey || st.areaTool) && editable() && !e.ctrlKey && !e.metaKey && !e.shiftKey;
        const p = draws ? pointAt(e.clientX, e.clientY) : null;
        if (!draws || p === null) {
          press = { x: e.clientX, y: e.clientY };
          return;
        }
        e.preventDefault(); // no text selection, no compatibility mouse events for the text layer and the links
        e.stopPropagation();
        drag = { page: p.page, u0: p.u, v0: p.v, x0: e.clientX, y0: e.clientY, pointerId: e.pointerId, moved: false, tool: st.areaTool && !e.altKey, alt: e.altKey };
        try {
          scroller()?.setPointerCapture(e.pointerId);
        } catch {
          // the pointer is gone already: pointerup ends the drag anyway
        }
        if (host.textSelection.ranges().length > 0) host.textSelection.clear();
        set({ hover: null });
        crosshair();
      },
      { signal, capture: true },
    );

    const endDrag = (e: PointerEvent, cancelled: boolean) => {
      const d = drag;
      if (d === null || e.pointerId !== d.pointerId) return;
      drag = null;
      swallowClick = true;
      setTimeout(() => (swallowClick = false), 0); // the click after this pointerup, if there is one, comes first
      crosshair();
      const [u, v] = onDragPage(d, e.clientX, e.clientY);
      const rect = ordered([d.u0, d.v0, u, v]);
      const { w, h } = screenSize(d.page, rect);
      if (cancelled || !d.moved || w < MIN_AREA_PX || h < MIN_AREA_PX) {
        set({ drawing: null });
        // Alt+click: selects the figure there, medium-confidence ones included.
        if (!cancelled && !d.moved && d.alt) select(figureAt(peek(d.page), d.page, sizeOf(d.page), d.u0, d.v0, true));
        return;
      }
      set({ drawing: { page: d.page, rect } });
      finishDrawing(d, rect);
    };
    window.addEventListener('pointerup', (e) => endDrag(e, false), { signal, capture: true });
    window.addEventListener('pointercancel', (e) => endDrag(e, true), { signal, capture: true });

    // The click after a drawn rectangle does nothing else (no link, no mark focus, no card).
    window.addEventListener(
      'click',
      (e) => {
        if (!swallowClick) return;
        swallowClick = false;
        e.preventDefault();
        e.stopPropagation();
      },
      { signal, capture: true },
    );

    // A click (no drag) selects the figure under it; a click elsewhere on the pages lets the selected one go.
    window.addEventListener(
      'click',
      (e) => {
        const p0 = press;
        press = null;
        if (e.button !== 0 || e.detail > 1 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (!inScroller(e.target) || ownClick(e.target)) return;
        if (e.target instanceof Element && e.target.closest('a') !== null) return; // a link: it is followed
        if (p0 === null || Math.hypot(e.clientX - p0.x, e.clientY - p0.y) > CLICK_SLOP_PX) return;
        if (host.textSelection.ranges().length > 0) return; // the click ended a selection
        const p = pointAt(e.clientX, e.clientY);
        if (p === null) {
          select(null);
          return;
        }
        if (areaMarkAt(p.page, p.u, p.v) !== null) {
          select(null); // the mark layer focuses the area mark
          return;
        }
        select(figureAt(peek(p.page), p.page, sizeOf(p.page), p.u, p.v));
      },
      { signal },
    );

    // Right-click on a figure or an area: its own menu. With text selected, the mark-up menu (S13) has it.
    window.addEventListener(
      'contextmenu',
      (e) => {
        if (e.defaultPrevented) return;
        if (performance.now() - keyMenuAt < KEY_MENU_MS) {
          keyMenuAt = -Infinity;
          e.preventDefault();
          return;
        }
        if (e.shiftKey || !inScroller(e.target) || dialogOpen()) return;
        if (host.textSelection.ranges().length > 0) return;
        const p = pointAt(e.clientX, e.clientY);
        if (p === null) return;
        const area = areaMarkAt(p.page, p.u, p.v);
        let r: Region | null = area;
        if (area !== null) {
          select(null);
          session.setFocusedMark(area.markId);
        } else {
          const f =
            figureAt(peek(p.page), p.page, sizeOf(p.page), p.u, p.v) ??
            (st.selected !== null && st.selected.page === p.page && contains(st.selected.rect, p.u, p.v) ? st.selected : null);
          if (f !== null) {
            select(f);
            r = { kind: 'figure', found: f };
          }
        }
        if (r === null) return;
        e.preventDefault();
        set({ menu: { at: { x: e.clientX, y: e.clientY }, region: r } });
      },
      { signal, capture: true },
    );

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && altHeld !== (e.type === 'keydown')) {
        altHeld = e.type === 'keydown';
        crosshair();
      }
      // A menu or a dialog that closed on this Esc (Radix marks the key as used) keeps the figure selected.
      if (e.type !== 'keydown' || e.key !== 'Escape' || e.defaultPrevented || isTypingTarget(e.target) || overlayOpen()) return;
      if (drag !== null) {
        try {
          scroller()?.releasePointerCapture(drag.pointerId);
        } catch {
          // already released
        }
        drag = null;
        set({ drawing: null });
        crosshair();
      } else if (st.areaTool) setAreaTool(false);
      else if (st.selected !== null) select(null);
    };
    window.addEventListener('keydown', onKey, { signal });
    window.addEventListener('keyup', onKey, { signal });
    window.addEventListener(
      'blur',
      () => {
        altHeld = false;
        crosshair();
      },
      { signal },
    );

    // The menu key and Shift+F10 open the figure menu for the selected figure or area (with no text selected).
    const offKeys = installShortcuts([
      {
        id: 'figures.menu',
        keys: ['Shift+F10', 'ContextMenu'],
        enabled: () => region() !== null && host.textSelection.ranges().length === 0 && !overlayOpen(),
        run: () => {
          const r = region();
          if (r === null) return;
          const page = r.kind === 'figure' ? r.found.page : r.page;
          const rect = r.kind === 'figure' ? r.found.rect : r.rect;
          const size = sizeOf(page);
          const at = size ? host.pageList.current?.clientPointOf({ pageIndex: page, x: rect[2] * size.width, y: rect[1] * size.height }) : undefined;
          const area = scroller()?.getBoundingClientRect();
          if (!at || !area || !Number.isFinite(at.x)) return;
          const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
          keyMenuAt = performance.now();
          set({ menu: { at: { x: clamp(at.x, area.left + 8, area.right - 8), y: clamp(at.y, area.top + 8, area.bottom - 8) }, region: r } });
        },
      },
    ]);

    setSpecialNoteTarget(noteTarget);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      attachedCount--;
      ac.abort();
      offKeys();
      offSession();
      offSelection();
      offFigures();
      clearHold();
      liveEl.remove();
      live = null;
      setSpecialNoteTarget(null);
      setToolOn(false);
      scroller()?.removeAttribute('data-sop-crosshair');
    };
  }

  // ---------------------------------------------------------------- what the pages draw

  let builtVersion = -1;
  let builtState: unknown = null;
  let model = new Map<number, FigureLayerPage>();
  let signatures = new Map<number, string>();

  function build(): void {
    const s = session.state();
    if (builtVersion === version && builtState === s) return;
    builtVersion = version;
    builtState = s;
    const notes = new Map<number, FigureLayerNote[]>();
    // An area mark already outlines its rect: a note on the same rect draws only while its card is active.
    const areaRects = new Map<number, NormRect[]>();
    for (const m of s.marks) {
      const r = s.placement.get(m.id);
      const a = r?.placed === true ? r.anchor : null;
      if (m.style !== 'area' || a?.kind !== 'area') continue;
      let list = areaRects.get(a.page);
      if (!list) areaRects.set(a.page, (list = []));
      list.push(a.rect);
    }
    for (const t of s.threads) {
      const place = notePlace(placedAnchor(t, s.placement.get(t.id)));
      if (place === null || place.pin !== null) continue;
      const active = s.active === t.id;
      if (!active && areaRects.get(place.page)?.some((r) => sameRect(r, place.rect, 0.98)) === true) continue;
      let list = notes.get(place.page);
      if (!list) notes.set(place.page, (list = []));
      list.push({ id: t.id, rect: place.rect, active, ...(place.figure === null || place.rect !== place.figure ? { onEdge: true } : {}) });
    }
    const pagesWith = new Set<number>(notes.keys());
    if (st.hover) pagesWith.add(st.hover.page);
    if (st.selected) pagesWith.add(st.selected.page);
    if (st.drawing) pagesWith.add(st.drawing.page);
    const next = new Map<number, FigureLayerPage>();
    const sigs = new Map<number, string>();
    for (const page of pagesWith) {
      const hover = st.hover?.page === page && !sameFigure(st.hover, st.selected) ? st.hover.rect : null;
      const selected = st.selected?.page === page ? st.selected.rect : null;
      const drawing = st.drawing?.page === page ? st.drawing.rect : null;
      const list = notes.get(page) ?? [];
      const sig = JSON.stringify([hover, selected, drawing, list]);
      sigs.set(page, sig);
      const prev = model.get(page);
      next.set(page, prev !== undefined && signatures.get(page) === sig ? prev : { hover, selected, drawing, notes: list });
    }
    model = next;
    signatures = sigs;
  }

  const layer: FigureLayerSource = {
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    page(pageIndex) {
      build();
      return model.get(pageIndex) ?? EMPTY_PAGE;
    },
    drawn(pageIndex, page) {
      const t = outlineTiming;
      if (t === null || t.page !== pageIndex || page.hover === null) return;
      outlineTiming = null;
      performance.mark('sop:figure-outline', { detail: { ms: performance.now() - t.t0 } });
    },
  };

  return {
    host,
    state: () => st,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    layer,
    thumbnails,
    attach,
    attached: () => attachedCount > 0,
    pagePainted,
    select,
    region,
    behaviours() {
      const noText = () => host.textSelection.ranges().length === 0;
      return {
        'figures.copyImage': {
          enabled: () => region() !== null && noText() && !overlayOpen(),
          run: () => {
            const r = region();
            if (r !== null) copy(r);
          },
        },
        'tools.area': { enabled: editable, run: () => setAreaTool(!st.areaTool), checked: () => st.areaTool },
      };
    },
    comment: (r) => runComment(noteReleasing(r)),
    copy,
    removeArea(id) {
      void session.removeMark(id);
      if (session.state().focusedMark === id) session.setFocusedMark(null);
    },
    closeMenu: () => {
      if (st.menu !== null) set({ menu: null });
    },
    setAreaTool,
    editable,
    dispose() {
      disposed = true;
      clearHold();
      thumbnails.dispose();
      listeners.clear();
    },
  };
}

/** `keep` only when there is one (exactOptionalPropertyTypes). */
function withKeep(keep: { clientX: number; clientY: number } | undefined): { keep?: { clientX: number; clientY: number } } {
  return keep === undefined ? {} : { keep };
}
