// The viewer's toolbar on a phone (swapped in for apps/extension/src/viewer/chrome/Toolbar.tsx by vite.config.ts; same props).
// The desktop pill does not fit a phone, and pinch and double-tap already zoom. What stays is the page: a small chip at the
// bottom, "3 / 12", that shows while the pages move and fades a moment after they stop, as in Drive's app. Tap it to type
// a page number (the ⋮ menu's "Go to page" opens the same box).
import type { ToolbarProps } from '@ext/viewer/chrome/Toolbar';
import { pageAtPosition, positionOfPage } from '@sop/core/page-order';
import { useViewerState } from '@sop/viewer';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import styles from './PhoneToolbar.module.css';

export type { ToolbarProps, ToolbarView } from '@ext/viewer/chrome/Toolbar';

/** How long the chip stays after the page last changed. */
const SHOWN_MS = 2500;

export function Toolbar({ view }: ToolbarProps) {
  if (view === null) return null;
  return <PageChip view={view} />;
}

function PageChip({ view }: { view: NonNullable<ToolbarProps['view']> }) {
  const { store, pageCount, onGoToPage, pageFieldRef } = view;
  const current = useViewerState(store, (s) => positionOfPage(s.pageOrder, s.currentPage));
  const [shown, setShown] = useState(true);
  const [typing, setTyping] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Shown while the pages move (any scroll in the page list), and when the page changes.
  useEffect(() => {
    const wake = () => {
      setShown(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setShown(false), SHOWN_MS);
    };
    wake();
    const onScroll = (e: Event) => e.target instanceof Element && e.target.matches('[role="document"]') && wake();
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true });
      clearTimeout(timer.current);
    };
  }, [current]);

  const go = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(typing);
    setTyping(null);
    pageFieldRef.current?.blur();
    if (!Number.isInteger(n) || n < 1) return;
    onGoToPage(pageAtPosition(store.get().pageOrder, Math.min(pageCount, n) - 1));
  };

  return (
    <form className={styles.chip} data-shown={shown || typing !== null ? '' : undefined} data-viewer-chrome="" onSubmit={go}>
      <label className={styles.label}>
        <span className={styles.srOnly}>Page</span>
        <input
          ref={pageFieldRef}
          className={styles.field}
          inputMode="numeric"
          enterKeyHint="go"
          aria-label={`Page, of ${pageCount}`}
          value={typing ?? String(current + 1)}
          size={String(pageCount).length}
          onFocus={(e) => {
            setTyping('');
            e.currentTarget.select();
          }}
          onBlur={() => setTyping(null)}
          onChange={(e) => setTyping(e.currentTarget.value.replace(/\D/gu, ''))}
        />
      </label>
      <span className={styles.total} aria-hidden="true">
        / {pageCount}
      </span>
    </form>
  );
}
