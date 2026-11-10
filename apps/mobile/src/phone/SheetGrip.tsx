// The notes panel as a bottom sheet on a phone. Swapped in for the panel's resize edge
// (apps/extension/src/viewer/notes-panel/PanelEdge.tsx, same props) by vite.config.ts: on a phone the panel is not a column
// to make wider, but a sheet to pull up and down (viewer-phone.css places it at the bottom).
//
// The sheet has three heights, as Google's apps do: peek (a third of the screen: the newest notes, the page still in view),
// half, and full. Drag the grip at its top, or the "Notes" header, and let go: it settles on the nearest height, or the next
// one in the direction of a quick flick. Pulled below peek, it closes. It opens at half, and a note or reply box taking the
// caret brings it up to half from peek, so the box sits above the keyboard and the words it is about stay in view above it.
import type { PanelEdgeProps } from '@ext/viewer/notes-panel/PanelEdge';
import { notesPanel } from '@ext/viewer/notes-panel/panel-state';
import { useEffect, useRef } from 'react';

export type { PanelEdgeProps } from '@ext/viewer/notes-panel/PanelEdge';

type Snap = 'peek' | 'half' | 'full';
const SNAPS: Snap[] = ['peek', 'half', 'full'];
/** The sheet's height variable on the page's root (viewer-phone.css). */
const HEIGHT_VAR = '--phone-sheet-h';
/** A flick faster than this (px per ms) moves one height in its direction. */
const FLICK = 0.5;
/** Pulled this far below peek, the sheet closes. */
const CLOSE_BELOW_PX = 48;

/** A height's size in px now (the tokens are in vh). */
function sizeOf(snap: Snap): number {
  const probe = document.createElement('div');
  probe.style.cssText = `position:fixed;visibility:hidden;block-size:var(--phone-sheet-${snap})`;
  document.body.appendChild(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return h;
}

function show(h: Snap | number): void {
  const root = document.documentElement;
  root.style.setProperty(HEIGHT_VAR, typeof h === 'number' ? `${Math.round(h)}px` : `var(--phone-sheet-${h})`);
  root.dataset.sheet = typeof h === 'number' ? 'dragging' : h;
}

export function PanelEdge({ panel, panelId }: PanelEdgeProps) {
  const grip = useRef<HTMLDivElement>(null);
  const snap = useRef<Snap>('half');

  useEffect(() => {
    show('half');
    return () => {
      document.documentElement.style.removeProperty(HEIGHT_VAR);
      delete document.documentElement.dataset.sheet;
    };
  }, []);

  // A box in the sheet taking the caret: the sheet goes full height.
  useEffect(() => {
    const el = panel.current;
    if (el === null) return;
    const onFocus = (e: FocusEvent) => {
      if (!(e.target instanceof HTMLTextAreaElement) || snap.current !== 'peek') return;
      snap.current = 'half';
      show('half');
    };
    el.addEventListener('focusin', onFocus);
    return () => el.removeEventListener('focusin', onFocus);
  }, [panel]);

  // Dragging: the grip, and the sheet's header (its title row, not its buttons).
  useEffect(() => {
    const handle = grip.current;
    const el = panel.current;
    if (handle === null || el === null) return;
    let drag: { id: number; y0: number; h0: number; last: { y: number; t: number }; v: number } | null = null;
    const start = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (t === undefined || e.touches.length !== 1) return;
      if (e.currentTarget === el) {
        const target = e.target instanceof Element ? e.target : null;
        const header = el.firstElementChild;
        if (target === null || header === null || !header.contains(target) || target.closest('button, [role="menu"]') !== null) return;
      }
      drag = { id: t.identifier, y0: t.clientY, h0: el.getBoundingClientRect().height, last: { y: t.clientY, t: e.timeStamp }, v: 0 };
    };
    const move = (e: TouchEvent) => {
      const t = drag === null ? undefined : [...e.changedTouches].find((c) => c.identifier === drag?.id);
      if (drag === null || t === undefined) return;
      e.preventDefault();
      const dt = Math.max(1, e.timeStamp - drag.last.t);
      drag.v = (t.clientY - drag.last.y) / dt; // + is downwards
      drag.last = { y: t.clientY, t: e.timeStamp };
      show(Math.min(sizeOf('full'), Math.max(0, drag.h0 - (t.clientY - drag.y0))));
    };
    const end = (e: TouchEvent) => {
      const t = drag === null ? undefined : [...e.changedTouches].find((c) => c.identifier === drag?.id);
      if (drag === null || t === undefined) return;
      const h = drag.h0 - (t.clientY - drag.y0);
      const v = drag.v;
      drag = null;
      if (h < sizeOf('peek') - CLOSE_BELOW_PX || (v > FLICK && snap.current === 'peek')) {
        notesPanel.setOpen(false);
        return;
      }
      let next: Snap;
      if (Math.abs(v) > FLICK) {
        const i = SNAPS.indexOf(snap.current);
        next = SNAPS[Math.min(SNAPS.length - 1, Math.max(0, v < 0 ? i + 1 : i - 1))] ?? 'half';
      } else {
        next = SNAPS.reduce((best, s) => (Math.abs(sizeOf(s) - h) < Math.abs(sizeOf(best) - h) ? s : best), 'half' as Snap);
      }
      snap.current = next;
      show(next);
    };
    for (const target of [handle, el]) {
      target.addEventListener('touchstart', start, { passive: true });
      target.addEventListener('touchmove', move, { passive: false });
      target.addEventListener('touchend', end);
      target.addEventListener('touchcancel', end);
    }
    return () => {
      for (const target of [handle, el]) {
        target.removeEventListener('touchstart', start);
        target.removeEventListener('touchmove', move);
        target.removeEventListener('touchend', end);
        target.removeEventListener('touchcancel', end);
      }
    };
  }, [panel]);

  // The grip is a button for the keyboard and screen readers: each press moves to the next height, round to peek.
  const step = () => {
    const next = SNAPS[(SNAPS.indexOf(snap.current) + 1) % SNAPS.length] ?? 'half';
    snap.current = next;
    show(next);
  };

  return (
    <div ref={grip} className="sop-sheet-grip" role="button" tabIndex={0} aria-controls={panelId} aria-label="Notes sheet size: drag up or down" onClick={step} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && step()}>
      <span className="sop-sheet-grip-bar" />
    </div>
  );
}
