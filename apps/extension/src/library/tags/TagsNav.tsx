// The left column's "Tags" (R92), under the pages: every tag with how many readings carry it, as Gmail lists its labels in
// Drive's navigation pills. A click shows My library with only that tag's readings. Each tag has a menu (⋮, or a
// right-click): Rename, Merge into another tag, Delete.
import { Icon, IconButton } from '@sop/ui';
import { PointMenu } from '@sop/ui/library';
import { useContext, useId, useMemo, useState } from 'react';
import { LibraryContext } from '../app/context';
import { sayWith } from './say';
import { cx, navOrder, readingsCount, TAG_ICON } from './tag-format';
import { TagManage, type TagAction, tagMenu } from './TagManage';
import { tagHref } from './tag-route';
import type { TagSummary } from './tags-data';
import styles from './TagsNav.module.css';
import { useTagList } from './use-tags';

export interface TagsNavProps {
  /** The tag the address shows, so its pill is selected. */
  current: string | null;
}

export function TagsNav({ current }: TagsNavProps) {
  const ctx = useContext(LibraryContext);
  const tags = ctx?.data.tags ?? null;
  const list = useTagList(tags);
  const shown = useMemo(() => (list === null ? [] : navOrder(list)), [list]);
  const heading = useId();
  const [menu, setMenu] = useState<{ tag: TagSummary; at: { x: number; y: number }; align: 'start' | 'end' } | null>(null);
  const [manage, setManage] = useState<{ action: TagAction; tag: TagSummary } | null>(null);
  if (ctx === null || tags === null || shown.length === 0) return null;
  const say = sayWith(ctx.notify);

  return (
    <nav className={styles.nav} aria-labelledby={heading}>
      <div id={heading} className={styles.heading}>
        Tags
      </div>
      <ul className={styles.list}>
        {shown.map((t) => {
          const selected = t.id === current;
          return (
            <li key={t.id} className={cx(styles.entry, selected && styles.selected)}>
              <a
                className={styles.item}
                href={tagHref(t.id)}
                aria-current={selected ? 'page' : undefined}
                title={`${t.name}: ${readingsCount(t.count)}${t.autoCount > 0 ? `, ${t.autoCount} added for you` : ''}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ tag: t, at: { x: e.clientX, y: e.clientY }, align: 'start' });
                }}
              >
                <Icon name={TAG_ICON[t.kind]} size={20} filled={selected} />
                <span className={styles.label}>{t.name}</span>
                <span className={styles.count} aria-label={readingsCount(t.count)}>
                  {t.count > 0 ? t.count : ''}
                </span>
              </a>
              <IconButton
                icon="more_vert"
                size={32}
                iconSize={20}
                label={`Tag actions for ${t.name}`}
                className={styles.more}
                aria-haspopup="menu"
                onClick={() => {
                  const r = document.activeElement?.getBoundingClientRect();
                  if (r !== undefined) setMenu({ tag: t, at: { x: r.right, y: r.bottom }, align: 'end' });
                }}
              />
            </li>
          );
        })}
      </ul>
      <PointMenu
        at={menu?.at ?? null}
        align={menu?.align}
        label="Tag actions"
        items={menu === null ? [] : tagMenu(menu.tag, (action) => setManage({ action, tag: menu.tag }))}
        onClose={() => setMenu(null)}
      />
      <TagManage
        tags={tags}
        all={list}
        open={manage}
        onClose={() => setManage(null)}
        say={say}
        onGone={(gone, into) => {
          if (gone === current) location.hash = into === null ? '#/library' : tagHref(into);
        }}
      />
    </nav>
  );
}
