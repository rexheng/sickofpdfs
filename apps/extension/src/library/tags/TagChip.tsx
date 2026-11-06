// A tag chip, as Drive draws its labels: the owner's own tags are tonal; an auto tag (the categoriser's) is lighter, with
// a dashed edge and the word "auto". Used on rows and cards (small) and in the details and the Tags dialog.
import { Icon } from '@sop/ui';
import type { ComponentPropsWithRef } from 'react';
import styles from './TagChip.module.css';
import { cx, KIND_WORD } from './tag-format';
import type { ReadingTag } from './tags-data';

export interface TagChipProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  tag: Pick<ReadingTag, 'name' | 'kind' | 'source'>;
  /** Extra words after the name ("2 of 3"). */
  note?: string;
}

/** The chip's tooltip: what it is, in plain words. */
export function chipTitle(tag: Pick<ReadingTag, 'name' | 'kind' | 'source'>): string {
  const kind = KIND_WORD[tag.kind].toLowerCase();
  return tag.source === 'auto' ? `${tag.name}: a ${kind} sickofpdfs added. Click to keep it or remove it.` : `${tag.name}: show every reading with this ${kind}`;
}

/** A chip that is a button (a click shows the tag, or offers Keep and Remove for an auto tag). */
export function TagChip({ tag, note, className, ...rest }: TagChipProps) {
  const auto = tag.source === 'auto';
  return (
    <button type="button" title={chipTitle(tag)} {...rest} className={cx(styles.chip, auto ? styles.auto : styles.owner, className)} data-tag-chip="">
      <span className={styles.name}>{tag.name}</span>
      {note !== undefined && <span className={styles.note}>{note}</span>}
      {auto && <span className={styles.autoMark}>auto</span>}
    </button>
  );
}

/** A chip that only shows (no action of its own), for a place where the actions sit beside it. */
export function TagLabel({ tag, note, className }: { tag: Pick<ReadingTag, 'name' | 'kind' | 'source'>; note?: string; className?: string }) {
  const auto = tag.source === 'auto';
  return (
    <span className={cx(styles.chip, styles.still, auto ? styles.auto : styles.owner, className)}>
      <span className={styles.name}>{tag.name}</span>
      {note !== undefined && <span className={styles.note}>{note}</span>}
      {auto && <span className={styles.autoMark}>auto</span>}
    </span>
  );
}

/**
 * "+2": more tags than fit. With `onClick` it is a button that shows them all (the reading's Tags). `tagged`: there is no
 * room for a chip at all, so it says how many tags there are with the tag icon ("🏷 2"), as the note count beside it does.
 */
export function MoreTags({
  count,
  title,
  className,
  onClick,
  tabIndex,
  tagged = false,
}: {
  count: number;
  title: string;
  className?: string;
  onClick?: () => void;
  tabIndex?: number;
  tagged?: boolean;
}) {
  const shown = tagged ? (
    <>
      <Icon name="sell" size={20} />
      <span>{count}</span>
    </>
  ) : (
    `+${count}`
  );
  if (onClick === undefined) {
    return (
      <span className={cx(styles.chip, styles.more, tagged && styles.tagged, className)} title={title}>
        {shown}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cx(styles.chip, styles.more, styles.moreButton, tagged && styles.tagged, className)}
      title={title}
      aria-label={`${title}. Show them all`}
      tabIndex={tabIndex}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {shown}
    </button>
  );
}
