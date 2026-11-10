// The notes panel's width and spacing (R107), remembered on this computer.
//
// - Width: the owner drags the panel's inner edge (PanelEdge.tsx), from 280 px up to half the window. What is kept is the
//   width they chose; a narrower window shows less of it for now (at most half the window, never under 280 px), and the
//   chosen width comes back when the window does. Double-click the edge, or "Reset width" in the panel's menu: 320 px.
// - Spacing: Compact (the default: the title, the tabs and the first card close together) or Comfortable (Docs' own
//   sidebar spacing). It sets the panel's header and card spacing; the margin cards keep Docs' spacing, since each one
//   sits level with its mark.
//
// Both live in the extension's localStorage (this computer, every PDF; web pages and content scripts cannot read it),
// read synchronously, so a panel opens at its size with no jump. Another open tab follows a change at once.
import { useSyncExternalStore } from 'react';

export const PANEL_MIN_W = 280;
export const PANEL_DEFAULT_W = 320;
/** One arrow key press on the edge moves it this far; with Shift, PANEL_KEY_STEP_BIG. */
export const PANEL_KEY_STEP = 16;
export const PANEL_KEY_STEP_BIG = 64;

export type NotesSpacing = 'compact' | 'comfortable';
export const DEFAULT_SPACING: NotesSpacing = 'compact';

const WIDTH_KEY = 'sop:notesPanel.width';
const SPACING_KEY = 'sop:notesPanel.spacing';

/** The widest the panel may be in a window this wide: half of it, and never less than the narrowest. */
export function maxPanelWidth(windowWidth: number): number {
  return Math.max(PANEL_MIN_W, Math.floor(windowWidth / 2));
}

/** A width the panel can take in a window this wide: whole pixels, 280 px up to half the window. */
export function clampPanelWidth(w: number, windowWidth: number): number {
  return Math.round(Math.min(maxPanelWidth(windowWidth), Math.max(PANEL_MIN_W, w)));
}

/** The width the panel is drawn at: the chosen width, as wide as the window allows now (CSS, so a resize follows). */
export function panelWidthCss(w: number): string {
  return `min(${Math.round(w)}px, max(${PANEL_MIN_W}px, 50vw))`;
}

/**
 * Draws the panel at width `w` (or back at the token's 320 px, with null): the panel, the page column that ends before it
 * (App.module.css) and the find bar all read --sop-notes-panel-w. It is set on the page's root, so a drag changes it
 * without a React render.
 */
export function showPanelWidth(w: number | null): void {
  const root = document.documentElement.style;
  if (w === null) root.removeProperty('--sop-notes-panel-w');
  else root.setProperty('--sop-notes-panel-w', panelWidthCss(w));
}

function pref<T>(key: string, parse: (raw: string | null) => T, fallback: T) {
  const read = (): T => {
    try {
      return parse(localStorage.getItem(key));
    } catch {
      return fallback;
    }
  };
  let value: T | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const cb of [...listeners]) cb();
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key !== key && e.key !== null) return;
    const next = read();
    if (next === value) return;
    value = next;
    notify();
  };
  const get = (): T => {
    value ??= read();
    return value;
  };
  return {
    get,
    set(this: void, next: T): void {
      if (next === get()) return;
      value = next;
      try {
        if (next === fallback) localStorage.removeItem(key);
        else localStorage.setItem(key, String(next));
      } catch {
        // storage full or blocked: the choice still holds in this tab
      }
      notify();
    },
    subscribe(this: void, cb: () => void): () => void {
      if (listeners.size === 0) window.addEventListener('storage', onStorage);
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0) window.removeEventListener('storage', onStorage);
      };
    },
  };
}

/** The width the owner chose (CSS px). */
export const notesPanelWidth = pref<number>(
  WIDTH_KEY,
  (raw) => {
    const n = Number(raw);
    return raw !== null && Number.isFinite(n) && n >= PANEL_MIN_W ? Math.round(n) : PANEL_DEFAULT_W;
  },
  PANEL_DEFAULT_W,
);

/** Compact or Comfortable. */
export const notesPanelSpacing = pref<NotesSpacing>(
  SPACING_KEY,
  (raw) => (raw === 'comfortable' || raw === 'compact' ? raw : DEFAULT_SPACING),
  DEFAULT_SPACING,
);

export function useNotesPanelWidth(): number {
  return useSyncExternalStore(notesPanelWidth.subscribe, notesPanelWidth.get);
}

export function useNotesPanelSpacing(): NotesSpacing {
  return useSyncExternalStore(notesPanelSpacing.subscribe, notesPanelSpacing.get);
}
