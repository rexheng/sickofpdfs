import type { Author } from '@sop/core';
import '../../tokens/comments.css';
import { Icon } from '../../icons/Icon';
import { cx } from '../classes';
import styles from './CommentAvatar.module.css';

/** The name shown above a comment. The owner has no account name in Release 1, so their notes read "You". */
export const AUTHOR_NAME: Record<Author, string> = { me: 'You', claude: 'Claude' };

/**
 * The 32 px round avatar of a comment (Docs margin cards, 02 section 4.11). The owner gets Google's person avatar on
 * the tonal blue of Drive's chips; Claude gets its own mark on a warm accent, so its replies stand out at a glance.
 * It is decoration: the author's name is written next to it.
 */
export function CommentAvatar({ author, className }: { author: Author; className?: string }) {
  return (
    <span className={cx(styles.avatar, author === 'claude' ? styles.claude : styles.me, className)} aria-hidden="true">
      {author === 'claude' ? <ClaudeMark /> : <Icon name="person" size={24} filled />}
    </span>
  );
}

/** Ray end points of Claude's mark: ten rounded rays around the centre, long and short in turn. */
const RAYS = Array.from({ length: 10 }, (_, i) => {
  const angle = (i * 36 - 90) * (Math.PI / 180);
  const outer = i % 2 === 0 ? 8.6 : 6.4;
  const inner = 2.4;
  const at = (r: number) => [12 + r * Math.cos(angle), 12 + r * Math.sin(angle)].map((v) => v.toFixed(2));
  const [x1, y1] = at(inner);
  const [x2, y2] = at(outer);
  return `M${x1} ${y1}L${x2} ${y2}`;
}).join('');

/** A small spark drawn in the current colour: the mark next to Claude's name. */
export function ClaudeMark({ className }: { className?: string }) {
  return (
    <svg className={cx(styles.mark, className)} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={RAYS} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}
