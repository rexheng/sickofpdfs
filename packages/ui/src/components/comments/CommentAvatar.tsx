import type { Author } from '@sop/core';
import '../../tokens/comments.css';
import { Icon } from '../../icons/Icon';
import { cx } from '../classes';
import styles from './CommentAvatar.module.css';

/** The name shown above a comment. The owner has no account name in Release 1, so their notes read "You". */
export const AUTHOR_NAME: Record<Author, string> = { me: 'You', claude: 'Claude' };

/**
 * The 32 px round avatar of a comment (Docs margin cards, 02 section 4.11). The owner gets Google's person avatar on
 * the tonal blue of Drive's chips; Claude gets its sparkle on a warm accent, so its replies stand out at a glance.
 * It is decoration: the author's name is written next to it.
 */
export function CommentAvatar({ author, className }: { author: Author; className?: string }) {
  return (
    <span className={cx(styles.avatar, author === 'claude' ? styles.claude : styles.me, className)} aria-hidden="true">
      {author === 'claude' ? <ClaudeMark /> : <Icon name="person" size={24} filled />}
    </span>
  );
}

/**
 * Claude's mark next to its name: the sparkle (Material Symbols `auto_awesome`, filled), the one Claude icon of the
 * whole interface (controller ruling, Phase 4: Settings → Claude, Ask Claude in the menus and the figure toolbar use it).
 */
export function ClaudeMark({ className }: { className?: string }) {
  return <Icon name="auto_awesome" size={20} filled className={cx(styles.mark, className)} />;
}
