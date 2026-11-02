// One note thread on the Notes page and on Home: a Google Docs comment card (02 section 4.11) on the library's white card,
// in Drive's tonal surface. Its head names the reading (a click opens it) and where the note is ("p. 4 · “the passage”");
// then the comments as the viewer shows them. On Home it is short: the first comment, at most 4 lines, and how many replies.
import type { Anchor } from '@sop/core';
import { CommentItem, FileTypeIcon, TextButton } from '@sop/ui';
import { type MouseEvent, useState } from 'react';
import type { NoteItem } from '../../data/pages-data';
import styles from './NoteCard.module.css';

/** Where a note is, in the words the viewer's notes panel uses: "Whole document", "p. 4". */
export function whereLabel(anchor: Anchor, pageIndex: number | null): string {
  if (anchor.kind === 'document') return 'Whole document';
  const page = pageIndex ?? ('page' in anchor ? anchor.page : null);
  return page === null ? 'Whole document' : `p. ${page + 1}`;
}

/** What the note is on, when it is on something: the passage, or the figure's name. */
export function onWhat(anchor: Anchor): string | null {
  if (anchor.kind === 'text') return `“${anchor.quote.quote.replace(/\s+/g, ' ').trim()}”`;
  if (anchor.kind === 'figure') return anchor.figure.label ?? 'A figure';
  if (anchor.kind === 'area') return 'An area of the page';
  return null;
}

export interface NoteCardProps {
  note: NoteItem;
  /** "Now", for the times ("3:15 PM Today"). */
  now: number;
  /** Home: the first comment only, cut at 4 lines, and how many replies. */
  compact?: boolean;
  onOpen(this: void): void;
  /** In Trash: puts the note back on its reading. */
  onRestore?(this: void): void;
}

export function NoteCard({ note, now, compact = false, onOpen, onRestore }: NoteCardProps) {
  const [expanded, setExpanded] = useState(false);
  const { thread, comments, title } = note;
  const what = onWhat(thread.anchor);
  const shown = compact ? comments.slice(0, 1) : comments;
  const replies = comments.length - 1;
  // A click anywhere on the card opens the reading, except on its own buttons and links.
  const onClick = (e: MouseEvent<HTMLElement>) => {
    if (onRestore !== undefined || (e.target as HTMLElement).closest('button, a') !== null) return;
    if (window.getSelection()?.toString() !== '') return; // the owner is selecting text to copy
    onOpen();
  };
  return (
    <article className={onRestore === undefined ? `${styles.card} ${styles.opens}` : styles.card} aria-label={`Note on ${title}`} onClick={onClick}>
      <div className={styles.head}>
        <FileTypeIcon kind="pdf" size={18} />
        <button type="button" className={styles.title} title={onRestore === undefined ? `Open ${title}` : title} onClick={onRestore === undefined ? onOpen : undefined} disabled={onRestore !== undefined}>
          {title}
        </button>
      </div>
      <p className={styles.where}>
        <span className={styles.page}>{whereLabel(thread.anchor, thread.pageIndex)}</span>
        {what !== null && (
          <>
            <span aria-hidden="true">·</span>
            <span className={styles.quote}>{what}</span>
          </>
        )}
      </p>
      <div className={styles.comments}>
        {shown.map((c) => (
          <CommentItem key={c.id} comment={c} now={now} clamp={compact && !expanded} onShowMore={() => setExpanded(true)} />
        ))}
      </div>
      {((compact && replies > 0) || onRestore !== undefined) && (
        <div className={styles.foot}>
          {compact && replies > 0 && <span className={styles.replies}>{replies === 1 ? '1 reply' : `${replies} replies`}</span>}
          {onRestore !== undefined && <TextButton label="Restore" icon="restore_from_trash" onClick={onRestore} />}
        </div>
      )}
    </article>
  );
}
