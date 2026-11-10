// The rail's Figures tab (Phase 2, S16; research 06 section 4): every figure and table found in the PDF, each with a
// 64 px thumbnail, its label ("Figure 3", "Table 2") and its page. A click, or Enter, goes to the figure and selects
// it. It is the keyboard path to figures, so no new shortcut is needed.
//
// - One tab stop: ArrowUp and ArrowDown move between the figures, Home and End go to the first and last.
// - While the pages are still being searched, a quiet line says how far it has got. When none are found it says so,
//   and how to mark an area instead (a scan has no figures to find until text recognition, Release 3).
// - Thumbnails are drawn on this computer, only for the rows that are on screen (`onShow`).
// The tab only shows what it is given; the extension's figures feature finds the figures and draws the thumbnails.
import { type JSX, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import styles from './FiguresTab.module.css';

export interface FiguresTabItem {
  /** Unique in the list; `onShow` and `onSelect` hand it back. */
  key: string;
  /** "Figure 3", "Table IV", or "Figure" for one without a caption. */
  label: string;
  pageIndex: number;
  /** R108: the page number shown for it (the reader's page order); pageIndex + 1 when not given. */
  pageNumber?: number;
  /** An object or data URL drawn on this computer; null until it is drawn. */
  thumbnail: string | null;
}

export interface FiguresTabProps {
  items: readonly FiguresTabItem[];
  /** How far the search for figures has got; null once every page has been searched. */
  progress: { done: number; total: number } | null;
  /** The key of the selected figure, if it is in the list. */
  selectedKey: string | null;
  onSelect(this: void, item: FiguresTabItem): void;
  /** A row came into view: its thumbnail is wanted. */
  onShow?(this: void, key: string): void;
}

export function FiguresTab({ items, progress, selectedKey, onSelect, onShow }: FiguresTabProps): JSX.Element {
  const list = useRef<HTMLOListElement>(null);
  const [keyIndex, setKeyIndex] = useState<number | null>(null);
  const selectedIndex = items.findIndex((i) => i.key === selectedKey);
  const tabStop = Math.min(items.length - 1, Math.max(0, keyIndex ?? (selectedIndex >= 0 ? selectedIndex : 0)));

  // Thumbnails for the rows on screen (and a little beyond). The rows are looked for again when the list changes.
  const keys = items.map((i) => i.key).join('\n');
  useEffect(() => {
    const root = list.current;
    if (!root || !onShow) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const key = (e.target as HTMLElement).dataset.figureKey;
          if (e.isIntersecting && key !== undefined) onShow(key);
        }
      },
      { root: root.parentElement, rootMargin: '200px 0px' },
    );
    for (const el of root.querySelectorAll<HTMLElement>('[data-figure-key]')) io.observe(el);
    return () => io.disconnect();
  }, [keys, onShow]);

  const onKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    const step: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity, PageDown: 5, PageUp: -5 };
    const d = step[e.key];
    if (d === undefined || e.altKey || e.ctrlKey || e.metaKey || items.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const next = Math.min(items.length - 1, Math.max(0, tabStop + d));
    setKeyIndex(next);
    list.current?.querySelector<HTMLElement>(`[data-figure-index="${next}"]`)?.focus();
  };

  const searching = progress !== null && progress.done < progress.total;
  return (
    <nav aria-label="Figures" className={styles.tab}>
      {items.length > 0 && (
        <ol ref={list} className={styles.list} onKeyDown={onKeyDown}>
          {items.map((item, i) => (
            <li key={item.key} className={styles.item}>
              <button
                type="button"
                className={styles.row}
                data-figure-key={item.key}
                data-figure-index={i}
                aria-current={item.key === selectedKey ? 'true' : undefined}
                aria-label={`${item.label}, page ${item.pageNumber ?? item.pageIndex + 1}`}
                tabIndex={i === tabStop ? 0 : -1}
                // A click goes to the figure without taking the focus, so the reading keys keep moving the pages.
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  if (e.currentTarget.closest('ol')?.contains(document.activeElement)) e.currentTarget.focus();
                  setKeyIndex(i);
                  onSelect(item);
                }}
              >
                {item.thumbnail !== null ? (
                  <img className={styles.thumb} src={item.thumbnail} alt="" draggable={false} />
                ) : (
                  <span className={styles.thumb} aria-hidden="true" />
                )}
                <span className={styles.text}>
                  <span className={styles.label}>{item.label}</span>
                  <span className={styles.page}>Page {item.pageNumber ?? item.pageIndex + 1}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {searching && (
        <p className={styles.status} role="status">
          Looking for figures… page {progress.done} of {progress.total}
        </p>
      )}
      {!searching && items.length === 0 && (
        <div className={styles.empty} role="status">
          <p className={styles.emptyTitle}>No figures found</p>
          <p className={styles.emptyHint}>To mark part of a page, hold Alt and drag.</p>
        </div>
      )}
    </nav>
  );
}
