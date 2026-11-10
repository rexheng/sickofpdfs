// Find (Ctrl+F, Task 25): the search behind the find bar. It matches the query against each page's chars folded the
// way anchoring folds them (find-text.ts): no case, no accents, ligatures as letters, line breaks as spaces, and words
// split by a line-end hyphen found whole. Every hit is a range of PDFium char indices, so the highlights and Alt+Enter's
// selection cover exactly the matched chars.
//
// Speed, for a 600-page book as much as for a paper:
// - Pages are searched nearest first: the page in view, then the pages after and before it in turn, so the first hits
//   near the reader come in at once. Hits stream in as pages are searched.
// - One page's chars are read from the engine at a time, so the pages being drawn never wait behind a search; folded
//   page text is kept, so the next query reads nothing from the engine.
// - The work between engine reads runs in slices of a few milliseconds and then yields, so typing and scrolling stay
//   smooth while a query runs over cached text.
// - A new query cancels the old search (after a short pause in typing).
//
// R108: with a page order, "pages" above means the pages as the reader sees them: the search runs out from the page in
// view in that order, the hits are numbered in it, and Enter steps through them in it. A new order starts the open search
// again (orderChanged); the pages' text is kept, so that is quick.
//
// For speed checks it leaves performance marks: sop:find-start (a query's search begins, after the typing pause),
// sop:find-first-hit (its first hits are in) and sop:find-done (every page searched).
//
// Hits carry no rects (`rects` is empty): the highlights and the jump read the line rects of the pages in view
// (markLineRects), the same rects a selection is painted with.
import type { DocHandle, PdfBackend, SearchHit } from '../backend/types';
import { positionOfPage } from '@sop/core/page-order';
import type { FindController, FindState } from '../contracts';
import { buildFindText, findKey, findPattern, type FindText, matchFindText } from './find-text';

/** Typing pause before a query is searched (contracts.ts). */
const DEBOUNCE_MS = 150;
/** Work done before yielding to the page (input, painting). */
const SLICE_MS = 8;
/** The bar's count is updated at most this often while hits stream in (the first hits and the current hit at once). */
const NOTIFY_MS = 60;

export interface FindControllerOptions {
  /** Default 150 ms. */
  debounceMs?: number;
  /**
   * Phase 7: where a page's chars are read (PageTextProvider.rawText, which answers a scanned page with its recognised text).
   * Default: the engine's getPageChars.
   */
  chars?: (pageIndex: number) => Promise<string>;
  /** R108: the reader's page order (the page at each position; null for the file's own), read when a search starts. */
  order?: () => readonly number[] | null;
}

/**
 * One query's search: the pages searched so far are the run lo..hi, which always holds the start page. `start`, `lo` and
 * `hi` are positions in `order` (R108: the order the pages were shown in when the search started).
 */
interface Run {
  query: string;
  key: string;
  pattern: RegExp;
  order: readonly number[] | null;
  start: number;
  lo: number;
  /** hi < lo until the first page is searched. */
  hi: number;
  pageHits: Map<number, SearchHit[]>;
  /** pageHits flattened in page order; rebuilt when `dirty`. */
  hits: SearchHit[];
  dirty: boolean;
  current: SearchHit | null;
  /** next() or previous() was asked for a hit on pages not searched yet: search that way first, then move. */
  pending: -1 | 0 | 1;
  letters: number;
  failed: number;
  complete: boolean;
}

const EMPTY: FindState = { query: '', hits: [], current: -1, complete: true };

/** Yields to the browser between slices (scheduler.postTask where Chrome has it). */
function yieldToPage(): Promise<void> {
  const s = (globalThis as { scheduler?: { postTask?: (cb: () => void) => Promise<void> } }).scheduler;
  if (typeof s?.postTask === 'function') return s.postTask(() => {});
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The page at a position of a run's order, and the position of a page. */
const pageAt = (order: readonly number[] | null, position: number): number => (order ? order[position] : position);
const placeOf = (order: readonly number[] | null, pageIndex: number): number => positionOfPage(order, pageIndex);

/** Index of the first hit at or after (position, start) in hits sorted by position (as shown) then start. */
function lowerBound(hits: readonly SearchHit[], order: readonly number[] | null, position: number, start: number): number {
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const h = hits[mid];
    const at = placeOf(order, h.pageIndex);
    if (at < position || (at === position && h.start < start)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function indexOfHit(hits: readonly SearchHit[], order: readonly number[] | null, h: SearchHit): number {
  const i = lowerBound(hits, order, placeOf(order, h.pageIndex), h.start);
  return i < hits.length && hits[i].pageIndex === h.pageIndex && hits[i].start === h.start ? i : -1;
}

/**
 * The find controller for an open document. `startPage` is read when a search starts: the page the reader is on.
 * It reads each page's chars once (getPageChars) and keeps them folded until dispose().
 */
export function createFindController(
  backend: PdfBackend,
  doc: DocHandle,
  pageCount: number,
  startPage: () => number,
  o: FindControllerOptions = {},
): FindController {
  const debounceMs = o.debounceMs ?? DEBOUNCE_MS;
  const texts = new Map<number, FindText>();
  const loads = new Map<number, Promise<FindText | null>>();
  const listeners = new Set<(s: FindState) => void>();
  let state: FindState = EMPTY;
  let run: Run | null = null;
  let typed: string | null = null; // a query waiting for the typing pause
  let typingTimer: ReturnType<typeof setTimeout> | undefined;
  let notifyTimer: ReturnType<typeof setTimeout> | undefined;
  let lastNotify = -Infinity;
  let disposed = false;

  const now = () => performance.now();

  /** The page's folded chars; null when the engine could not read them (not remembered, so a later search tries again). */
  function load(pageIndex: number): Promise<FindText | null> {
    let p = loads.get(pageIndex);
    if (!p) {
      p = (o.chars ? o.chars(pageIndex) : backend.getPageChars(doc, pageIndex)).then(
        (raw) => {
          const t = buildFindText(raw);
          if (!disposed) texts.set(pageIndex, t);
          loads.delete(pageIndex);
          return t;
        },
        () => {
          loads.delete(pageIndex);
          return null;
        },
      );
      loads.set(pageIndex, p);
    }
    return p;
  }

  function flatten(r: Run): void {
    if (!r.dirty) return;
    const out: SearchHit[] = [];
    if (r.lo <= r.hi) for (let p = r.lo; p <= r.hi; p++) {
      const hs = r.pageHits.get(pageAt(r.order, p));
      if (hs) for (const h of hs) out.push(h);
    }
    r.hits = out;
    r.dirty = false;
  }

  /**
   * Settles which hit is current. The first hit at or after the start page is current as soon as it is found (every
   * page from the start page to it has been searched by then); with none, the first hit once every page is searched.
   * A pending next() or previous() moves on once the hit it needs has been found.
   */
  function settle(r: Run): void {
    flatten(r);
    const hits = r.hits;
    if (hits.length === 0) {
      if (r.complete) r.pending = 0;
      return;
    }
    if (r.current === null) {
      const i = lowerBound(hits, r.order, r.start, 0);
      if (i < hits.length) r.current = hits[i];
      else if (r.complete) r.current = hits[0];
      if (r.current !== null) r.pending = 0;
      return;
    }
    if (r.pending === 0) return;
    const at = indexOfHit(hits, r.order, r.current);
    if (r.pending === 1) {
      if (at + 1 < hits.length) r.current = hits[at + 1];
      else if (r.complete) r.current = hits[0];
      else return;
    } else {
      if (at > 0) r.current = hits[at - 1];
      else if (r.complete) r.current = hits[hits.length - 1];
      else return;
    }
    r.pending = 0;
  }

  function snapshot(r: Run | null, query: string): FindState {
    if (r === null) return { ...EMPTY, query };
    settle(r);
    const s: FindState = { query: r.query, hits: r.hits, current: r.current === null ? -1 : indexOfHit(r.hits, r.order, r.current), complete: r.complete };
    if (r.complete && r.failed === 0 && r.letters === 0) s.noText = true;
    return s;
  }

  function notifyNow(): void {
    clearTimeout(notifyTimer);
    notifyTimer = undefined;
    lastNotify = now();
    state = snapshot(run, state.query);
    for (const cb of [...listeners]) cb(state);
  }

  /** Throttled, except when the bar must change at once: the first hits, the current hit, the end of the search. */
  function notify(urgent: boolean): void {
    if (disposed) return;
    if (urgent || now() - lastNotify >= NOTIFY_MS) {
      notifyNow();
      return;
    }
    notifyTimer ??= setTimeout(notifyNow, Math.max(0, NOTIFY_MS - (now() - lastNotify)));
  }

  /** The next page to search: nearest to the start page, the later one first; the way a pending step needs first. */
  function nextPage(r: Run): number {
    if (r.hi < r.lo) return r.start;
    const up = r.hi + 1 < pageCount;
    const down = r.lo > 0;
    if (r.pending === 1 && up) return r.hi + 1;
    if (r.pending === -1 && down) return r.lo - 1;
    if (up && (!down || r.hi + 1 - r.start <= r.start - (r.lo - 1))) return r.hi + 1;
    return r.lo - 1;
  }

  async function search(r: Run): Promise<void> {
    let sliceFrom = now();
    let first = true;
    while (!(r.lo === 0 && r.hi === pageCount - 1)) {
      const position = nextPage(r);
      const page = pageAt(r.order, position);
      let t = texts.get(page) ?? null;
      if (t === null) {
        t = await load(page);
        sliceFrom = now(); // the engine read gave the page its turn
      }
      if (r !== run || disposed) return;
      const hadHits = r.hits.length > 0 || r.dirty;
      const wasCurrent = r.current;
      if (t === null) {
        r.failed++;
      } else {
        r.letters += t.letters;
        const found = matchFindText(t, r.pattern);
        if (found.length > 0) {
          r.pageHits.set(
            page,
            found.map((m) => ({ pageIndex: page, start: m.start, count: m.count, rects: [] })),
          );
          r.dirty = true;
        }
      }
      if (r.hi < r.lo) r.lo = r.hi = position;
      else if (position > r.hi) r.hi = position;
      else r.lo = position;
      settle(r);
      if (!hadHits && r.hits.length > 0) performance.mark('sop:find-first-hit');
      notify(first || (!hadHits && r.hits.length > 0) || r.current !== wasCurrent);
      first = false;
      if (now() - sliceFrom > SLICE_MS) {
        await yieldToPage();
        if (r !== run || disposed) return;
        sliceFrom = now();
      }
    }
    r.complete = true;
    performance.mark('sop:find-done');
    notify(true);
  }

  /** Searches for `query` now. True when that starts a new search (not the same words in another case or spacing). */
  function begin(query: string, again = false): boolean {
    typed = null;
    clearTimeout(typingTimer);
    const key = findKey(query);
    if (key === '') {
      run = null;
      state = { ...EMPTY, query };
      notify(true);
      return true;
    }
    if (run !== null && run.key === key && !again) {
      run.query = query;
      notify(true);
      return false;
    }
    const order = o.order?.() ?? null;
    const shown = order !== null && order.length === pageCount ? order : null;
    const start = placeOf(shown, Math.min(pageCount - 1, Math.max(0, Math.round(startPage()))));
    const r: Run = {
      query,
      key,
      pattern: findPattern(key),
      order: shown,
      start,
      lo: 0,
      hi: -1,
      pageHits: new Map(),
      hits: [],
      dirty: false,
      current: null,
      pending: 0,
      letters: 0,
      failed: 0,
      complete: pageCount === 0,
    };
    run = r;
    performance.mark('sop:find-start');
    if (r.complete) notify(true);
    else void search(r);
    return true;
  }

  /**
   * A query still waiting for the typing pause is searched now (Enter right after typing). True when that started a
   * new search: its first hit becomes current by itself, so the step is not taken as well.
   */
  function flushTyping(): boolean {
    return typed !== null && begin(typed);
  }

  function step(dir: 1 | -1): SearchHit | null {
    if (disposed || flushTyping()) return null;
    const r = run;
    if (r === null) return null;
    settle(r);
    if (r.current === null || r.hits.length === 0) return null;
    const at = indexOfHit(r.hits, r.order, r.current);
    const to = at + dir;
    if (to >= 0 && to < r.hits.length) r.current = r.hits[to];
    else if (r.complete) r.current = dir === 1 ? r.hits[0] : r.hits[r.hits.length - 1];
    else {
      r.pending = dir; // the search turns that way, and the current hit moves when it is found
      return null;
    }
    r.pending = 0;
    notify(true);
    return r.current;
  }

  return {
    setQuery(q) {
      if (disposed) return;
      clearTimeout(typingTimer);
      if (findKey(q) === '') {
        begin(q);
        return;
      }
      typed = q;
      typingTimer = setTimeout(() => begin(q), debounceMs);
    },
    next: () => step(1),
    previous: () => step(-1),
    get state() {
      return state;
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    refreshPage(pageIndex) {
      const old = texts.get(pageIndex);
      texts.delete(pageIndex);
      loads.delete(pageIndex);
      const r = run;
      // A page the open search has passed is searched again with its new text; one it has not reached is read when it gets there.
      if (r === null || disposed || r.hi < r.lo || placeOf(r.order, pageIndex) < r.lo || placeOf(r.order, pageIndex) > r.hi) return;
      void load(pageIndex).then((t) => {
        if (r !== run || disposed || t === null) return;
        r.letters += t.letters - (old?.letters ?? 0);
        const found = matchFindText(t, r.pattern);
        if (found.length > 0) r.pageHits.set(pageIndex, found.map((m) => ({ pageIndex, start: m.start, count: m.count, rects: [] })));
        else r.pageHits.delete(pageIndex);
        // The current hit's char positions were the old text's: it moves to the first hit from here on.
        if (r.current?.pageIndex === pageIndex) r.current = null;
        r.dirty = true;
        notify(true);
      });
    },
    orderChanged() {
      // The hits are numbered and stepped through in the order shown: the open search starts again in the new one.
      if (disposed || run === null) return;
      begin(run.query, true);
    },
    dispose() {
      disposed = true;
      clearTimeout(typingTimer);
      clearTimeout(notifyTimer);
      run = null;
      listeners.clear();
      texts.clear();
    },
  };
}
