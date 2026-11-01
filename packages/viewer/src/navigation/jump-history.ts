// Jumps inside the document (links in the PDF, find results) go through the page's history, collapsed (spec,
// "Navigate": "Back returns to where you were without needing many presses to leave").
//
// - The first jump stamps the current history entry with where the reader was ({ sopBase: from }) and pushes ONE entry
//   for the jump ({ sopJump: true }).
// - Later jumps, while that entry is current, replace it: a chain of jumps is still one entry.
// - Back (the browser's button, Alt+Left) lands on the stamped entry, and the reader goes back to the exact position.
//   Forward lands on the jump entry again and repeats the last jump.
// Scrolling, thumbnails and the outline never touch history.
import type { LinkTarget } from '../backend/types';
import type { JumpHistory, ViewPosition } from '../contracts';

type PageTarget = LinkTarget & { kind: 'page' };
type HistoryWindow = Pick<Window, 'history' | 'addEventListener' | 'removeEventListener'>;

/** The state of the entry the reader jumped from. */
interface BaseState {
  sopBase: ViewPosition;
}

const isJumpEntry = (state: unknown): boolean => typeof state === 'object' && state !== null && (state as { sopJump?: unknown }).sopJump === true;

/** The position stamped on a history entry, if it is one of ours and well formed. */
function basePosition(state: unknown): ViewPosition | null {
  if (typeof state !== 'object' || state === null) return null;
  const p = (state as Partial<BaseState>).sopBase;
  if (typeof p !== 'object' || p === null) return null;
  const { pageIndex, offset, scale } = p;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  return finite(pageIndex) && finite(offset) && finite(scale) ? { pageIndex, offset, scale } : null;
}

/**
 * Jump history for the viewer tab. `go` performs a jump (scrolls to the target); `restore` puts the reader back where
 * they were. Dispose it when the document closes.
 */
export function createJumpHistory(win: HistoryWindow, restore: (p: ViewPosition) => void, go: (t: PageTarget) => void): JumpHistory {
  /** The last jump made in this tab, for Forward. */
  let last: PageTarget | null = null;
  const onPopState = (e: Event) => {
    const state: unknown = (e as Partial<PopStateEvent> | undefined)?.state ?? win.history.state;
    const base = basePosition(state);
    if (base !== null) restore(base);
    else if (isJumpEntry(state) && last !== null) go(last);
  };
  win.addEventListener('popstate', onPopState);
  return {
    jumpTo(target, from) {
      const h = win.history;
      if (isJumpEntry(h.state)) {
        h.replaceState({ sopJump: true }, '');
      } else {
        const base: BaseState = { sopBase: { pageIndex: from.pageIndex, offset: from.offset, scale: from.scale } };
        h.replaceState(base, '');
        h.pushState({ sopJump: true }, '');
      }
      last = target;
      go(target);
    },
    dispose() {
      win.removeEventListener('popstate', onPopState);
    },
  };
}
