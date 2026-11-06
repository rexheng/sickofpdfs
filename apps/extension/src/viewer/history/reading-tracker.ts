// What the reader does with an open PDF, kept for the library's history (S16): reading time, the last spot (page, how far
// down it, zoom) and the pages visited.
//
// Privacy, the rule this file exists to keep: NOTHING about a PDF that is not saved is ever written. While the PDF is not
// in the library (still being checked, "Not sure", Not learning, the Save question open, memory-only) the tracker only
// counts in memory. The moment the save controller says `saved` it back-fills what it counted, and from then on it writes.
// - When the PDF stops being saved (Undo of a save, Forget, a forget in another tab) the tracker drops everything it
//   counted, so a later save starts afresh and nothing from before the forget comes back (R88).
// - Incognito never gets a tracker (use-reading-history.ts), and a PDF in the Trash is counted but not written.
// - It makes no network call. Its only output is the store's `recordReading`.
//
// Reading time counts only while the tab is visible and focused and the reader has done something in the last 60 s.
// The spot is written 5 s after it changes (at most one write every 5 s while it keeps changing), reading time on its own
// every 30 s, and everything again when the tab is hidden or goes.
import type { DocumentId, SaveState } from '@sop/core';
import type { ViewerStore, ViewPosition } from '@sop/viewer';
import type { ReadingReport, ReadingState } from '../../store/library-api';

/** The reader counts as away after this long without a key, a pointer move, a wheel turn or a scroll. */
export const IDLE_MS = 60_000;
/** A change of page, zoom or scroll is written this long after it (and not more often than this while it keeps changing). */
export const POSITION_SAVE_MS = 5_000;
/** Reading time with no other change is written this often. */
export const TIME_SAVE_MS = 30_000;
/** A page counts as visited once the reader has spent this long on it. */
export const VISIT_DWELL_MS = 1_000;

/**
 * Counts the milliseconds the reader is really reading: the tab is visible and focused, and the last activity was less
 * than `idleMs` ago. Pure: every call is told the time. Time that passes while idle is not counted, but the first `idleMs`
 * of a quiet spell is (someone reading a page does not touch the mouse).
 */
export function createActiveClock(idleMs: number, start: { now: number; visible: boolean; focused: boolean }) {
  let visible = start.visible;
  let focused = start.focused;
  let lastActivity = start.now;
  /** Counting since this time; null while hidden, blurred or idle. */
  let since: number | null = visible && focused ? start.now : null;
  let counted = 0;

  const settle = (now: number): void => {
    if (since === null) return;
    const limit = lastActivity + idleMs;
    counted += Math.max(0, Math.min(now, limit) - since);
    since = now >= limit ? null : now;
  };
  const becomeActive = (now: number): void => {
    lastActivity = now;
    if (visible && focused && since === null) since = now;
  };

  return {
    /** The reader did something. */
    activity(now: number): void {
      settle(now);
      becomeActive(now);
    },
    setVisible(v: boolean, now: number): void {
      settle(now);
      visible = v;
      if (!v) since = null;
      else becomeActive(now);
    },
    setFocused(f: boolean, now: number): void {
      settle(now);
      focused = f;
      if (!f) since = null;
      else becomeActive(now);
    },
    /** The milliseconds counted since the last `take`. */
    take(now: number): number {
      settle(now);
      const ms = counted;
      counted = 0;
      return ms;
    },
    /** Forgets what has been counted (the PDF was forgotten). */
    discard(now: number): void {
      settle(now);
      counted = 0;
    },
  };
}

/** The two library calls the tracker uses. */
export interface HistoryStore {
  recordReading(documentId: DocumentId, o: ReadingReport): Promise<void>;
  getReading(documentId: DocumentId): Promise<ReadingState | null>;
}

/** What the tracker reads of the save controller. */
export interface TrackedSave {
  readonly state: SaveState;
  /** The saved document is in the library's Trash: counted, not written. */
  readonly trashed: boolean;
  subscribe(cb: (s: SaveState) => void): () => void;
}

export interface ReadingTrackerDeps {
  save: TrackedSave;
  /** The library, once connected; null when it could not be reached (then nothing is written). */
  store: () => Promise<HistoryStore | null>;
  /** The viewer's view state: the page in view and the zoom. */
  view: Pick<ViewerStore, 'get' | 'subscribe'>;
  /** The reader's position now; null when it cannot be told (presenting, no pages yet): the last known one is used. */
  position(): ViewPosition | null;
  /**
   * Called once each time the PDF becomes saved, with the history the library already holds for it (null for a PDF that was
   * just saved). It runs before the first write, so a resume can move the view first and the old spot is not overwritten.
   */
  atSaved?(reading: ReadingState | null): Promise<void> | void;
  now?: () => number;
  doc?: Document;
  win?: Window;
}

export interface ReadingTracker {
  /** Writes what has been counted, when the PDF is saved. Never rejects. */
  flush(): Promise<void>;
  dispose(): void;
}

/** What the reader does counts as activity. `scroll` is caught in the capture phase: it does not bubble. */
const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

const samePosition = (a: ViewPosition | null, b: ViewPosition | null): boolean =>
  a !== null && b !== null && a.pageIndex === b.pageIndex && Math.abs(a.offset - b.offset) < 0.01 && Math.abs(a.scale - b.scale) < 1e-3;

export function createReadingTracker(d: ReadingTrackerDeps): ReadingTracker {
  const now = d.now ?? ((): number => Date.now());
  const doc = d.doc ?? document;
  const win = d.win ?? window;
  const clock = createActiveClock(IDLE_MS, { now: now(), visible: doc.visibilityState === 'visible', focused: doc.hasFocus() });

  // ---- what is counted (memory only until the PDF is saved) ----
  /** Reading time counted and not yet written. */
  let pendingMs = 0;
  /** Reading time on the page in view; at VISIT_DWELL_MS the page counts as visited. */
  let dwellMs = 0;
  let page = d.view.get().currentPage;
  const visited = new Set<number>();
  let lastKnown: ViewPosition | null = null;
  /** The page the page box showed with `lastKnown` (TB5: Home says that page). */
  let lastShown: number | null = null;

  // ---- what is written ----
  let writtenVisited = 0;
  let writtenPosition: ViewPosition | null = null;
  /** The saved document; set when it becomes saved, null when it stops being. */
  let docId: DocumentId | null = null;
  /** True once `atSaved` is done: from then on writes are allowed. */
  let writing = false;
  /** Bumped each time the PDF is left, so an answer that arrives late is dropped. */
  let generation = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerDue = 0;
  let queue: Promise<void> = Promise.resolve();

  const account = (at: number): void => {
    const ms = clock.take(at);
    pendingMs += ms;
    dwellMs += ms;
    if (dwellMs >= VISIT_DWELL_MS) visited.add(page);
  };

  const position = (): ViewPosition | null => {
    const p = d.position();
    if (p !== null) {
      lastKnown = p;
      lastShown = d.view.get().currentPage;
    }
    return p ?? lastKnown;
  };

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  /** Writes in `ms`, unless a write is already due sooner. Only once the PDF is being written. */
  const arm = (ms: number): void => {
    if (!writing || disposed) return;
    const due = now() + ms;
    if (timer !== null && timerDue <= due) return;
    clearTimer();
    timerDue = due;
    timer = setTimeout(() => void flush(), ms);
  };

  /** Drops everything counted: the PDF is no longer saved (Undo, Forget), so nothing of before it may come back. */
  const forgetCounted = (): void => {
    generation++;
    clearTimer();
    docId = null;
    writing = false;
    clock.discard(now());
    pendingMs = 0;
    dwellMs = 0;
    visited.clear();
    writtenVisited = 0;
    writtenPosition = null;
  };

  async function write(id: DocumentId, g: number): Promise<void> {
    const store = await d.store();
    if (store === null || g !== generation) return;
    account(now());
    const here = position();
    const ms = Math.round(pendingMs);
    const pages = [...visited].sort((a, b) => a - b);
    if (here === null || (ms < 1 && pages.length === writtenVisited && samePosition(here, writtenPosition))) return;
    try {
      await store.recordReading(id, {
        at: now(),
        msDelta: ms,
        position: { page: here.pageIndex, offset: here.offset, zoom: here.scale, ...(lastShown !== null ? { shown: lastShown } : {}) },
        pagesVisited: pages,
      });
    } catch (error) {
      // Still counted in memory: the next write sends it again. Nothing about the PDF goes in the message.
      if (g === generation) console.warn('sickofpdfs: reading history was not saved', error instanceof Error ? error.message.split(':')[0] : '');
      return;
    }
    if (g !== generation) return;
    pendingMs = Math.max(0, pendingMs - ms);
    writtenVisited = pages.length;
    writtenPosition = here;
  }

  function flush(): Promise<void> {
    clearTimer();
    if (disposed) return Promise.resolve();
    account(now());
    if (!writing || docId === null) return Promise.resolve();
    if (d.save.trashed) return Promise.resolve(); // counted; written once it is out of the Trash (the save controller says so)
    const id = docId;
    const g = generation;
    queue = queue.then(() => write(id, g)).catch(() => {});
    return queue;
  }

  /** The PDF became saved: read its history, let the resume run, then write what was counted so far. */
  async function begin(id: DocumentId): Promise<void> {
    const g = ++generation;
    docId = id;
    writing = false;
    const store = await d.store();
    if (store === null || g !== generation || disposed) return;
    let reading: ReadingState | null;
    try {
      reading = await store.getReading(id);
    } catch (error) {
      // Without the old spot, writing could overwrite it with page 1: write nothing in this tab.
      console.warn('sickofpdfs: reading history could not be read', error instanceof Error ? error.message.split(':')[0] : '');
      return;
    }
    if (g !== generation || disposed) return;
    try {
      await d.atSaved?.(reading);
    } catch (error) {
      console.warn('sickofpdfs: resuming failed', error instanceof Error ? error.message.split(':')[0] : '');
    }
    if (g !== generation || disposed) return;
    writing = true;
    void flush();
  }

  const onSaveState = (s: SaveState): void => {
    if (disposed) return;
    if (s.kind === 'saved') {
      if (docId !== s.documentId) void begin(s.documentId);
      else arm(POSITION_SAVE_MS); // the same PDF told again: it may have come out of the Trash
    } else if (docId !== null) {
      forgetCounted();
    }
  };

  // ---- what the reader does ----
  const onViewChange = (): void => {
    const next = d.view.get().currentPage;
    if (next !== page) {
      account(now()); // the time so far belongs to the page that was in view
      page = next;
      dwellMs = 0;
    }
    arm(POSITION_SAVE_MS);
  };
  const onActivity = (): void => {
    clock.activity(now());
    arm(TIME_SAVE_MS);
  };
  const onScroll = (): void => {
    clock.activity(now());
    arm(POSITION_SAVE_MS);
  };
  const onVisibility = (): void => {
    account(now());
    clock.setVisible(doc.visibilityState === 'visible', now());
    if (doc.visibilityState !== 'visible') void flush();
  };
  const onBlur = (): void => {
    account(now());
    clock.setFocused(false, now());
    void flush();
  };
  const onFocus = (): void => clock.setFocused(true, now());
  const onHide = (): void => void flush();

  const stops: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, fn: () => void, capture = false): void => {
    target.addEventListener(type, fn, { passive: true, capture });
    stops.push(() => target.removeEventListener(type, fn, { capture }));
  };
  for (const type of ACTIVITY_EVENTS) listen(doc, type, onActivity);
  listen(doc, 'scroll', onScroll, true);
  listen(doc, 'visibilitychange', onVisibility);
  listen(win, 'blur', onBlur);
  listen(win, 'focus', onFocus);
  listen(win, 'pagehide', onHide);
  stops.push(d.view.subscribe(onViewChange));
  stops.push(d.save.subscribe(onSaveState));
  onSaveState(d.save.state); // it may be saved already

  return {
    flush,
    dispose() {
      if (disposed) return;
      void flush(); // best effort: the document is going. It is queued before `disposed`, and a late answer is still written.
      disposed = true;
      clearTimer();
      for (const stop of stops) stop();
    },
  };
}
