// The mark-up menu on a phone (swapped in for apps/extension/src/viewer/annotations/MarkupMenu.tsx by vite.config.ts; same
// props). A phone has no right-click, so instead of a menu at the pointer a small bar floats just above the selected words
// (below them when there is no room above) while text is selected:
//   - the top row: the five highlight colours (a tap highlights in that colour), and Copy;
//   - the bottom row, each with its name under it: Underline, Bold, Strikethrough, Comment, and Ask Claude.
// A tap on a mark (it takes the focus ring) shows the mark's own bar: its colours, Comment and Remove.
//
// Every button runs the same code as the desktop menu (MarkInput and the viewer's commands), so a mark made here is the
// same mark, saved the same way, and comes back on its words after a reload. Ask Claude keeps its rules: it asks before
// sending, and on a private PDF it is greyed out with the reason under it.
import type { MarkupMenuProps } from '@ext/viewer/annotations/MarkupMenu';
import type { ViewerCommandId } from '@ext/viewer/commands';
import { readRuntime } from '@ext/viewer/runtime';
import type { MarkColor, MarkId } from '@sop/core';
import { Icon, type IconName, MARK_COLOR_NAMES, MARK_COLORS } from '@sop/ui';
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import styles from './SelectionBar.module.css';
import { endRects, pageSelection } from './touch-select';

export type { MarkupMenuProps } from '@ext/viewer/annotations/MarkupMenu';

/** Room kept between the bar and the words it acts on. */
const GAP = 12;
/** The bar keeps this far from the screen's edges. */
const EDGE = 8;
/** The notes sheet slides up in this long (viewer-phone.css). */
const SHEET_SETTLE_MS = 350;

/** Copies the selection the way Ctrl+C does (the text layer writes PDFium's text of the selected chars, R26). */
function copySelection(): void {
  document.execCommand('copy');
}

/** What is selected or focused now, re-read on every change. */
function useTarget(): { kind: 'selection' } | { kind: 'mark'; id: MarkId } | null {
  const session = readRuntime().annotations ?? null;
  const subscribe = useCallback(
    (cb: () => void) => {
      document.addEventListener('selectionchange', cb);
      const off = session?.subscribe(cb);
      return () => {
        document.removeEventListener('selectionchange', cb);
        off?.();
      };
    },
    [session],
  );
  const key = useSyncExternalStore(subscribe, () => {
    if (pageSelection() !== null) return 'selection';
    const id = session?.state().focusedMark ?? null;
    return id === null ? '' : `mark:${id}`;
  });
  if (key === 'selection') return { kind: 'selection' };
  return key.startsWith('mark:') ? { kind: 'mark', id: key.slice('mark:'.length) as MarkId } : null;
}

/** Where the words are: the selection's line boxes, or the focused mark's ring. */
function targetBox(kind: 'selection' | 'mark'): { top: number; bottom: number; left: number; right: number } | null {
  if (kind === 'selection') {
    const r = pageSelection();
    const ends = r === null ? null : endRects(r);
    if (ends === null) return null;
    return { top: ends.first.top, bottom: ends.last.bottom, left: Math.min(ends.first.left, ends.last.left), right: Math.max(ends.first.right, ends.last.right) };
  }
  const ring = document.querySelector('[data-mark="focus"]');
  const b = ring?.getBoundingClientRect();
  return b === undefined || b.width === 0 ? null : { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
}

/**
 * A new note opens the notes sheet over the lower part of the pages: once it is up, the pages scroll so the words the note
 * is on (their foot at `bottom`, in client px now) stay in view above it.
 */
function keepAboveSheet(bottom: number): void {
  setTimeout(() => {
    const sheet = document.querySelector('aside[data-notes-panel]')?.getBoundingClientRect();
    const pages = document.querySelector<HTMLElement>('[role="document"]');
    if (sheet === undefined || pages === null) return;
    const by = bottom + GAP * 2 - sheet.top;
    if (by > 0) pages.scrollBy({ top: by, behavior: 'smooth' });
  }, SHEET_SETTLE_MS);
}

export function MarkupMenu({ input, commands }: MarkupMenuProps) {
  const target = useTarget();
  const bar = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<CSSProperties | null>(null);

  // The bar follows its words as the pages scroll or zoom, and hides while they are off screen.
  useLayoutEffect(() => {
    if (target === null) {
      setAt(null);
      return;
    }
    let frame = 0;
    const place = () => {
      frame = 0;
      const box = targetBox(target.kind);
      const el = bar.current;
      const pages = document.querySelector('[role="document"]')?.getBoundingClientRect();
      if (box === null || el === null || pages === undefined || box.bottom < pages.top || box.top > pages.bottom) {
        setAt(null);
        return;
      }
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const above = box.top - GAP - h;
      // Below the words leaves room for the end handle under the last line.
      const top = above >= pages.top + EDGE ? above : Math.min(box.bottom + GAP * 3, pages.bottom - h - EDGE);
      const mid = (box.left + box.right) / 2;
      const left = Math.min(Math.max(mid - w / 2, EDGE), window.innerWidth - w - EDGE);
      setAt({ transform: `translate(${Math.round(left)}px, ${Math.round(top)}px)` });
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(place);
    };
    schedule();
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    document.addEventListener('selectionchange', schedule);
    window.addEventListener('resize', schedule);
    // The mark's ring is drawn a frame after it takes the focus.
    const late = setTimeout(schedule, 120);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(late);
      document.removeEventListener('scroll', schedule, { capture: true });
      document.removeEventListener('selectionchange', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [target?.kind, target?.kind === 'mark' ? target.id : null]); // eslint-disable-line react-hooks/exhaustive-deps

  // The desktop menu's own trigger (the keyboard's menu key) never opens a second menu here.
  useEffect(() => input.menu.subscribe(() => input.menu.get() !== null && input.menu.close()), [input]);

  if (target === null) return null;

  const command = (id: ViewerCommandId) => {
    const c = commands.get(id);
    return c === undefined || !c.built ? null : c;
  };
  const comment = command('marks.comment');
  const ask = command('claude.ask');

  let colour: MarkColor | null = null;
  let onColour: (c: MarkColor) => void;
  let actions: { id: string; label: string; icon: IconName; run: () => void; disabled?: boolean; why?: string | undefined }[];
  if (target.kind === 'selection') {
    const ranges = readRuntime().selectionRanges?.() ?? [];
    colour = ranges.length > 0 ? input.menuColour(ranges) : null;
    onColour = (c) => input.apply('highlight', { color: c });
    actions = [
      { id: 'underline', label: 'Underline', icon: 'format_underlined', run: () => input.apply('underline') },
      { id: 'bold', label: 'Bold', icon: 'format_bold', run: () => input.apply('bold') },
      { id: 'strike', label: 'Strike', icon: 'format_strikethrough', run: () => input.apply('strike') },
    ];
    if (comment !== null)
      actions.push({
        id: 'comment',
        label: 'Comment',
        icon: 'add_comment',
        run: () => {
          const words = targetBox('selection');
          comment.run();
          if (words !== null) keepAboveSheet(words.bottom);
        },
        disabled: !comment.enabled(),
        why: comment.disabledReason?.(),
      });
    if (ask !== null) {
      const off = !ask.enabled();
      actions.push({ id: 'ask', label: 'Ask Claude', icon: 'auto_awesome', run: () => ask.run(), disabled: off, why: off ? ask.disabledReason?.() : undefined });
    }
  } else {
    const mark = input.mark(target.id);
    if (mark === null) return null;
    colour = mark.color;
    onColour = (c) => input.recolor(target.id, c);
    actions = [];
    if (comment !== null)
      actions.push({
        id: 'comment',
        label: 'Comment',
        icon: 'add_comment',
        run: () => {
          if (mark.style === 'area') comment.run();
          else if (input.selectText(target.id)) comment.run();
        },
        disabled: !comment.enabled(),
      });
    actions.push({ id: 'remove', label: 'Remove', icon: 'delete', run: () => input.remove(target.id) });
  }
  const greyed = actions.find((a) => a.disabled === true && a.why !== undefined);

  return (
    <div
      ref={bar}
      className={styles.bar}
      role="toolbar"
      aria-label={target.kind === 'selection' ? 'Mark up' : 'Mark'}
      data-theme="dark"
      data-viewer-chrome=""
      data-shown={at !== null ? '' : undefined}
      style={at ?? undefined}
      // A press on the bar must not take the selection away from the words.
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
    >
      {(target.kind === 'selection' || colour !== null) && (
        <div className={styles.colours}>
          {MARK_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={styles.swatch}
              style={{ '--swatch': `var(--sop-mark-${c}-swatch)` } as CSSProperties}
              aria-label={target.kind === 'selection' ? `Highlight ${MARK_COLOR_NAMES[c].toLowerCase()}` : MARK_COLOR_NAMES[c]}
              aria-pressed={colour === c}
              onClick={() => onColour(c)}
            >
              {colour === c && <Icon name="check" size={20} />}
            </button>
          ))}
          {target.kind === 'selection' && (
            <button type="button" className={styles.copy} onClick={copySelection}>
              <Icon name="content_copy" size={20} />
              Copy
            </button>
          )}
        </div>
      )}
      <div className={styles.actions}>
        {actions.map((a) => (
          <button key={a.id} type="button" className={styles.action} disabled={a.disabled} onClick={a.run}>
            <Icon name={a.icon} />
            <span className={styles.actionLabel}>{a.label}</span>
          </button>
        ))}
      </div>
      {greyed !== undefined && <p className={styles.why}>{greyed.label}: {greyed.why}</p>}
    </div>
  );
}
