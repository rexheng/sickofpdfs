// A reading's tags after its name on a row, and under the page on a grid card. A click on one of your own tags shows every
// reading with it. A click on an auto tag offers Keep, Remove, and the readings with it. "+2" (the tags that do not show)
// opens the reading's Tags, where every tag is, auto ones with Keep and Remove (TB5: reachable at any width).
import type { DocumentId } from '@sop/core';
import { DropdownMenu } from '@sop/ui';
import type { MouseEvent } from 'react';
import { chipOrder } from './tag-format';
import { MoreTags, TagChip } from './TagChip';
import { showTag } from './tag-route';
import styles from './RowTags.module.css';
import type { ReadingTag, TagsData } from './tags-data';

export interface RowTagsProps {
  documentId: DocumentId;
  list: readonly ReadingTag[];
  tags: TagsData;
  say(this: void, text: string, undo?: () => void): void;
  /** How many chips at most; the rest are counted ("+2"). */
  max: number;
  /** Only the row that holds the tab stop has tabbable chips. */
  tabbable: boolean;
  /** A tag not to show: the one whose page the reading is listed on (it would say the same on every row). */
  except?: string | null;
  /** "+2" pressed: the reading's tags (the Tags dialog). Without it the count only shows. */
  onMore?: (() => void) | undefined;
}

const FAILED = 'That didn’t work. Try again.';

/** "2 more tags: policy, Deep Learning". */
const moreTitle = (rest: readonly ReadingTag[]): string => `${rest.length === 1 ? '1 more tag' : `${rest.length} more tags`}: ${rest.map((t) => t.name).join(', ')}`;

/** "Tags: Course: 14.01, Macroeconomics". */
const allTitle = (all: readonly ReadingTag[]): string => `Tags: ${all.map((t) => t.name).join(', ')}`;

/** Keeps a click or a double-click on a chip from also opening the reading. */
const own = (e: MouseEvent) => e.stopPropagation();

export function RowTags({ documentId, list, tags, say, max, tabbable, except = null, onMore }: RowTagsProps) {
  const ordered = chipOrder(list).filter((t) => t.tagId !== except);
  if (ordered.length === 0) return null;
  const shown = ordered.slice(0, max);
  const rest = ordered.slice(max);
  const tab = tabbable ? 0 : -1;
  const more = (count: number, title: string, className: string, tagged = false) => (
    <MoreTags count={count} title={title} className={className} tabIndex={tab} tagged={tagged} {...(onMore !== undefined ? { onClick: onMore } : {})} />
  );
  return (
    <span className={styles.tags} onDoubleClick={own}>
      {shown.map((t) =>
        t.source === 'owner' ? (
          <TagChip key={t.tagId} tag={t} tabIndex={tab} onClick={() => showTag(t.tagId)} />
        ) : (
          <DropdownMenu
            key={t.tagId}
            items={[
              {
                kind: 'item',
                id: 'keep',
                label: 'Keep this tag',
                // TB5: not a tick, which in these menus means "this is the current choice"
                icon: 'new_label',
                onSelect: () => void tags.keepAutoTag(documentId, t.tagId).then(() => say(`Kept “${t.name}”`), () => say(FAILED)),
              },
              {
                kind: 'item',
                id: 'remove',
                label: 'Remove this tag',
                icon: 'label_off',
                onSelect: () =>
                  void tags.removeTag(documentId, t.tagId).then(
                    () => say(`Removed “${t.name}”. It won’t be added to this reading again.`, () => void tags.addTag(documentId, t.name).catch(() => say(FAILED))),
                    () => say(FAILED),
                  ),
              },
              { kind: 'separator' },
              { kind: 'item', id: 'show', label: 'Show readings with this tag', icon: 'sell', onSelect: () => showTag(t.tagId) },
            ]}
            trigger={<TagChip tag={t} tabIndex={tab} aria-haspopup="menu" onClick={own} />}
          />
        ),
      )}
      {rest.length > 0 && more(rest.length, moreTitle(rest), styles.moreRest)}
      {/* No room for a chip after the title: only how many tags there are. */}
      {more(ordered.length, allTitle(ordered), styles.moreAll, true)}
    </span>
  );
}
