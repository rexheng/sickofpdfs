// The find bar (Ctrl+F, Task 25): a dark card under the toolbar pill, on the right, as Chrome places its own. It holds
// the search box, the count ("3 of 12"), previous and next, and close.
//
// Keys in the box: Enter goes to the next hit and Shift+Enter to the previous one, wrapping round at either end; Alt+Enter
// selects the hit (onSelectMatch); Esc closes the bar. Every move to a new current hit (the first one as you type, and
// each step) goes to onJump, which the viewer sends through its jump history, so Back returns to where you were.
import { IconButton, TextField } from '@sop/ui';
import { type JSX, type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SearchHit } from '../backend/types';
import type { FindController, FindState } from '../contracts';
import styles from './FindBar.module.css';

export interface FindBarProps {
  controller: FindController;
  /** A hit became the current one: show it. */
  onJump(this: void, h: SearchHit): void;
  /** Alt+Enter: select the current hit's text (the bar then closes). */
  onSelectMatch(this: void, h: SearchHit): void;
  /** Esc or the close button. */
  onClose(this: void): void;
  /** The words to start with: reopening the bar brings back the last search. */
  initialQuery?: string;
  /** Changes each time Ctrl+F is pressed: the box takes the focus with its words selected, ready to type over. */
  focusRequest?: number;
  /** Enter went past the last hit to the first ('first'), or Shift+Enter past the first to the last ('last'). */
  onWrap?(this: void, to: 'first' | 'last'): void;
  /**
   * The viewer's scan check already says this document is a scan (its pages are pictures with no text). The bar then
   * says so at once, before anything is typed and while the search runs, instead of only after every page has been
   * searched. If the search does find text, its count takes over.
   */
  scanned?: boolean;
  /**
   * Phase 7.5: the scan's pages are still being read, so a search may miss words on the pages left. The note under the box
   * says so ("Still reading pages 21–120. Results may be missing."); the count goes on growing as pages are read, and says
   * "None yet" rather than "No results" until the last page is read. Null or absent once every page is read.
   */
  reading?: string | null;
}

/** What the count says: "3 of 12", "No results" ("None yet" while pages are still being read), or nothing. */
function countText(s: FindState, query: string, reading: boolean): string {
  if (query.trim() === '') return '';
  if (s.hits.length > 0) return s.current >= 0 ? `${s.current + 1} of ${s.hits.length}` : '';
  if (reading) return s.complete ? 'None yet' : '';
  return s.complete && !s.noText ? 'No results' : '';
}

const hitKey = (s: FindState, h: SearchHit) => `${s.query}\u0000${h.pageIndex}:${h.start}:${h.count}`;

export function FindBar({ controller, onJump, onSelectMatch, onClose, initialQuery = '', focusRequest = 0, onWrap, scanned = false, reading = null }: FindBarProps): JSX.Element {
  const subscribe = useCallback((cb: () => void) => controller.subscribe(cb), [controller]);
  const state = useSyncExternalStore(subscribe, () => controller.state);
  const [query, setQuery] = useState(initialQuery);
  const input = useRef<HTMLInputElement>(null);

  // The search for the words the bar opens with.
  const opening = useRef(initialQuery);
  useEffect(() => {
    if (opening.current !== '') controller.setQuery(opening.current);
  }, [controller]);

  // Ctrl+F (opening, or again while open): the box, its words selected.
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusRequest]);

  // A new current hit (the first one for new words, or a step that waited for its page to be searched): show it.
  const current = state.current >= 0 ? (state.hits[state.current] ?? null) : null;
  const currentKey = current === null ? null : hitKey(state, current);
  const shown = useRef<string | null>(null);
  const jump = useRef(onJump);
  useLayoutEffect(() => {
    jump.current = onJump;
  });
  useEffect(() => {
    if (current === null || currentKey === shown.current) return;
    shown.current = currentKey;
    jump.current(current);
  }, [current, currentKey]);

  const step = (dir: 1 | -1) => {
    const before = controller.state.current;
    const h = dir === 1 ? controller.next() : controller.previous();
    if (h === null) return;
    const after = controller.state.current;
    // Always shown, even when it is the hit already current (the only hit, after scrolling away from it).
    shown.current = hitKey(controller.state, h);
    onJump(h);
    if (before >= 0 && (dir === 1 ? after < before : after > before)) onWrap?.(dir === 1 ? 'first' : 'last');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Enter' && e.target === input.current) {
      e.preventDefault();
      if (e.altKey) {
        if (current !== null) onSelectMatch(current);
      } else {
        step(e.shiftKey ? -1 : 1);
      }
    }
  };

  const count = countText(state, query, reading !== null);
  const none = state.hits.length === 0;
  const typed = query.trim() !== '';
  // A finished search knows for sure; until then (or before anything is typed) the scan check speaks for it. While a scan is
  // still being read, its reading note says more than either.
  const scanNote = reading === null && (typed && state.complete ? state.noText === true : scanned && none);
  const searching = typed && count === '' && !state.complete && !scanNote;
  return (
    // Esc anywhere in the bar (the box or a button) closes it.
    <div role="search" aria-label="Find in document" className={styles.bar} data-viewer-chrome="" onKeyDown={onKeyDown}>
      <div className={styles.row}>
        <TextField
          ref={input}
          type="search"
          label="Find in document"
          value={query}
          className={styles.field}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          onChange={(v) => {
            setQuery(v);
            controller.setQuery(v);
          }}
        />
        {/* A screen reader hears the count once the search is done (busy: not every number while hits stream in). */}
        <span className={styles.count} role="status" aria-busy={!state.complete}>
          {searching ? <span className={styles.searching}>Searching…</span> : count}
        </span>
        <span className={styles.separator} />
        <IconButton icon="keyboard_arrow_up" label="Previous match" shortcut="Shift+Enter" disabled={none} disabledReason={NO_MATCHES} onClick={() => step(-1)} />
        <IconButton icon="keyboard_arrow_down" label="Next match" shortcut="Enter" disabled={none} disabledReason={NO_MATCHES} onClick={() => step(1)} />
        <IconButton icon="close" label="Close" shortcut="Esc" onClick={onClose} />
      </div>
      <p role="status" className={styles.note}>
        {reading ?? (scanNote ? SCAN_NOTE : null)}
      </p>
    </div>
  );
}

/** Why Previous and Next are greyed out. */
const NO_MATCHES = 'there are no matches to go to';

/** A document whose pages have no text at all: say why nothing is found. */
const SCAN_NOTE = 'This is a scan, so there’s no text to search yet';
