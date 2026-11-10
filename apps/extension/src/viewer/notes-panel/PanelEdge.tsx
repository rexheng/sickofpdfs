// The notes panel's inner edge (R107): drag it to make the panel wider or narrower, from 280 px up to half the window.
// Double-click it to go back to 320 px. It is a window splitter for the keyboard too (role="separator"): Left makes the
// panel wider and Right narrower (Shift for bigger steps), Home the narrowest and End the widest.
//
// It sits in the 16 px gap between the pages and the panel (that gap is the room the page column leaves, App.module.css),
// and 4 px into the panel, so it is easy to catch. A quiet grip pill in the gap says it can be dragged; it brightens on
// hover and turns blue while dragging or focused.
//
// Smooth while dragging:
// - The width changes once a frame at most, with no React render, on the three boxes it moves only: the panel, the page
//   column (which ends before the panel) and this edge. The shared --sop-notes-panel-w on the page's root is set once,
//   when the drag ends: changing it restyles every element of the page (thousands of text-layer spans), about ten times
//   the cost of a frame.
// - The pages are not laid out again while the drag lasts (PageListApi.holdLayout): they are shown scaled and moved to
//   where the new width puts them, from what is on screen, so they keep ending before the panel at every width. When the
//   drag ends they are laid out and drawn once, at the size they settle at.
// The width is remembered once the drag ends.
import { type KeyboardEvent, type PointerEvent, type RefObject, useEffect, useRef, useState } from 'react';
import { clampPanelWidth, maxPanelWidth, notesPanelWidth, PANEL_DEFAULT_W, PANEL_KEY_STEP, PANEL_KEY_STEP_BIG, PANEL_MIN_W, showPanelWidth } from './panel-size';
import styles from './PanelEdge.module.css';

export interface PanelEdgeProps {
  /** The panel it sizes: where it starts from (the width it is drawn at now), and aria-controls. */
  panel: RefObject<HTMLElement | null>;
  panelId: string;
  /** The width the owner chose (aria-valuenow while nothing is being dragged). */
  width: number;
  /** Before a change of width by the keys: the pages hold their full renders until the keys have paused for `ms`. */
  onResizing(this: void, ms: number): void;
  /** A drag starts (true) or ends (false): the pages' layout waits for its end (PageListApi.holdLayout). */
  onDragging(this: void, on: boolean): void;
}

/** Full renders wait this long after the last change of width: a drag or a held arrow key renders once, at its end. */
const SETTLE_MS = 200;

/** The attribute on <html> while the edge is dragged: the resize cursor everywhere, and no text selection. */
const RESIZING_ATTR = 'data-notes-panel-resizing';

export function PanelEdge({ panel, panelId, width, onResizing, onDragging }: PanelEdgeProps) {
  const edge = useRef<HTMLDivElement>(null);
  const windowWidth = useWindowWidth();
  const drag = useRef<{ id: number; x: number; from: number; to: number; frame: number } | null>(null);

  /** The width the panel is drawn at now (the chosen one, or less in a narrow window). */
  const shown = () => Math.round(panel.current?.getBoundingClientRect().width ?? width);

  /** Says a width to screen readers. */
  const say = (w: number) => {
    edge.current?.setAttribute('aria-valuenow', String(w));
    edge.current?.setAttribute('aria-valuetext', widthWords(w));
  };

  /** One frame of a drag: the panel, the page column and the edge take width `w`. */
  const showLive = (w: number) => {
    setLiveWidth(w, panel.current, edge.current);
    say(w);
  };

  /**
   * A width chosen for good: remembered, and set on the page's root for everything that follows it. From the keys, the
   * pages render once the presses pause (a held arrow key is many presses).
   */
  const commit = (w: number, fromKeys: boolean) => {
    if (fromKeys) onResizing(SETTLE_MS);
    showPanelWidth(w);
    notesPanelWidth.set(w);
    setLiveWidth(null, panel.current, edge.current);
    say(w);
  };

  const finish = () => {
    const d = drag.current;
    if (d === null) return;
    drag.current = null;
    cancelAnimationFrame(d.frame);
    document.documentElement.removeAttribute(RESIZING_ATTR);
    edge.current?.removeAttribute('data-dragging');
    commit(d.to, false);
    onDragging(false);
  };
  // A drag that is still going when the panel closes ends where it is.
  useEffect(() => () => finish(), []); // eslint-disable-line react-hooks/exhaustive-deps -- finish reads refs only

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault(); // no text selection starts, and the caret stays where it was
    e.currentTarget.setPointerCapture(e.pointerId);
    const from = shown();
    drag.current = { id: e.pointerId, x: e.clientX, from, to: from, frame: 0 };
    document.documentElement.setAttribute(RESIZING_ATTR, '');
    e.currentTarget.setAttribute('data-dragging', '');
    onDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d === null || e.pointerId !== d.id) return;
    // The edge is on the panel's left: moving it left makes the panel wider.
    d.to = clampPanelWidth(d.from + (d.x - e.clientX), window.innerWidth);
    if (d.frame !== 0) return;
    d.frame = requestAnimationFrame(() => {
      d.frame = 0;
      if (drag.current === d) showLive(d.to);
    });
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) finish();
  };

  const set = (w: number, fromKeys: boolean) => commit(clampPanelWidth(w, window.innerWidth), fromKeys);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? PANEL_KEY_STEP_BIG : PANEL_KEY_STEP;
    const now = shown();
    const to =
      e.key === 'ArrowLeft' ? now + step
      : e.key === 'ArrowRight' ? now - step
      : e.key === 'Home' ? PANEL_MIN_W
      : e.key === 'End' ? maxPanelWidth(window.innerWidth)
      : e.key === 'Enter' ? PANEL_DEFAULT_W
      : null;
    if (to === null || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation(); // the arrows and Home/End are the edge's here, not the pages'
    set(to, true);
  };

  const max = maxPanelWidth(windowWidth);
  const now = Math.min(width, max);
  return (
    <div
      ref={edge}
      className={styles.edge}
      role="separator"
      aria-orientation="vertical"
      aria-label="Notes panel width"
      aria-description="Drag, or press the Left and Right arrow keys, to make the notes panel wider or narrower. Double-click or press Enter to go back to the usual width."
      aria-controls={panelId}
      aria-valuemin={PANEL_MIN_W}
      aria-valuemax={max}
      aria-valuenow={now}
      aria-valuetext={widthWords(now)}
      tabIndex={0}
      // Part of the panel: a press here is not a click away from the open note (notes/NotesLayer.tsx).
      data-notes-panel="edge"
      onPointerDown={onPointerDown}
      // A press leaves the focus where it was (a reply being typed keeps its caret); the keyboard reaches the edge by Tab.
      onMouseDown={(e) => e.preventDefault()}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onDoubleClick={() => set(PANEL_DEFAULT_W, false)}
      onKeyDown={onKeyDown}
    >
      <span className={styles.grip} aria-hidden="true" />
    </div>
  );
}

/** What a screen reader says for a width. */
function widthWords(w: number): string {
  return `${w} pixels wide`;
}

/** The window's width, kept up to date (the widest the panel may be is half of it). */
function useWindowWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

/**
 * A drag's width, straight on the boxes it moves (null: back to what --sop-notes-panel-w says). The page column ends 16 px
 * before the panel, which is 16 px from the window's edge (App.module.css); the edge reaches 4 px into the panel.
 */
function setLiveWidth(w: number | null, panel: HTMLElement | null, edge: HTMLElement | null): void {
  const column = document.querySelector<HTMLElement>('[data-page-column]');
  if (w === null) {
    panel?.style.removeProperty('inline-size');
    edge?.style.removeProperty('inset-inline-end');
    column?.style.removeProperty('inset-inline-end');
    return;
  }
  panel?.style.setProperty('inline-size', `${w}px`);
  edge?.style.setProperty('inset-inline-end', `calc(${w}px + var(--space-4) - var(--space-1))`);
  column?.style.setProperty('inset-inline-end', `calc(${w}px + 2 * var(--space-4))`);
}
