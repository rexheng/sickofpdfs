// My library narrowed to one tag: the title row reads as Drive's folder path, "My library › Deep Learning ▾", and the
// tag's name opens its menu (Rename, Merge, Delete), as Drive's folder title does. "My library" goes back to everything.
import { DropdownMenu, Icon } from '@sop/ui';
import { type ReactNode, useContext, useState } from 'react';
import { LibraryContext } from '../app/context';
import { sayWith } from './say';
import { readingsCount, TAG_ICON } from './tag-format';
import { TagManage, type TagAction, tagMenu } from './TagManage';
import { tagHref } from './tag-route';
import type { TagSummary } from './tags-data';
import styles from './TagTitle.module.css';

export interface TagTitleProps {
  tag: TagSummary | null;
  all: readonly TagSummary[] | null;
  /** At the right of the row (the layout toggle). */
  end?: ReactNode;
}

export function TagTitle({ tag, all, end }: TagTitleProps) {
  const ctx = useContext(LibraryContext);
  const [manage, setManage] = useState<{ action: TagAction; tag: TagSummary } | null>(null);
  const tags = ctx?.data.tags ?? null;
  return (
    <div className={styles.row}>
      <h1 className={styles.path}>
        <a className={styles.crumb} href="#/library">
          My library
        </a>
        <span className={styles.sep} aria-hidden="true">
          ›
        </span>
        {tag === null ? (
          <span className={styles.current}>Tag</span>
        ) : (
          <DropdownMenu
            items={tagMenu(tag, (action) => setManage({ action, tag }))}
            trigger={
              <button type="button" className={styles.tagButton} aria-label={`${tag.name}: tag actions`}>
                <Icon name={TAG_ICON[tag.kind]} size={24} />
                <span className={styles.current}>{tag.name}</span>
                <Icon name="arrow_drop_down" size={24} />
              </button>
            }
          />
        )}
      </h1>
      {tag !== null && <span className={styles.count}>{readingsCount(tag.count)}</span>}
      {end !== undefined && <div className={styles.end}>{end}</div>}
      {tags !== null && ctx !== null && (
        <TagManage
          tags={tags}
          all={all}
          open={manage}
          onClose={() => setManage(null)}
          say={sayWith(ctx.notify)}
          onGone={(_gone, into) => {
            location.hash = into === null ? '#/library' : tagHref(into);
          }}
        />
      )}
    </div>
  );
}
