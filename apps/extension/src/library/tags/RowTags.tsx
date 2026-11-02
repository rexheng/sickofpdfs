// A reading's tags after its name on a row, and under the page on a grid card. A click on one of your own tags shows every
// reading with it. A click on an auto tag offers Keep, Remove, and the readings with it.
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
}

const FAILED = 'That didn’t work. Try again.';

/** "2 more tags: policy, Deep Learning". */
const moreTitle = (rest: readonly ReadingTag[]): string => `${rest.length === 1 ? '1 more tag' : `${rest.length} more tags`}: ${rest.map((t) => t.name).join(', ')}`;

/** Keeps a click or a double-click on a chip from also opening the reading. */
const own = (e: MouseEvent) => e.stopPropagation();

export function RowTags({ documentId, list, tags, say, max, tabbable }: RowTagsProps) {
  if (list.length === 0) return null;
  const ordered = chipOrder(list);
  const shown = ordered.slice(0, max);
  const rest = ordered.slice(max);
  const tab = tabbable ? 0 : -1;
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
                icon: 'check',
                onSelect: () => void tags.keepAutoTag(documentId, t.tagId).then(() => say(`Kept “${t.name}”`), () => say(FAILED)),
              },
              {
                kind: 'item',
                id: 'remove',
                label: 'Remove this tag',
                icon: 'close',
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
      {rest.length > 0 && <MoreTags count={rest.length} title={moreTitle(rest)} className={styles.moreWide} />}
      {ordered.length > 1 && <MoreTags count={ordered.length - 1} title={moreTitle(ordered.slice(1))} className={styles.moreMedium} />}
    </span>
  );
}
