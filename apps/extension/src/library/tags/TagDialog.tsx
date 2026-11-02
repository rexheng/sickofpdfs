// "Tags…" from a row's menu or the selection bar: the tags of one reading, or of every selected reading at once.
import type { DocumentId } from '@sop/core';
import { Dialog } from '@sop/ui';
import styles from './TagDialog.module.css';
import { TagEditor } from './TagEditor';
import type { TagsData } from './tags-data';

export interface TagDialogProps {
  tags: TagsData;
  /** The readings to tag; null: closed. */
  target: { ids: readonly DocumentId[]; title: string } | null;
  onClose(this: void): void;
  say(this: void, text: string, undo?: () => void): void;
}

export function TagDialog({ tags, target, onClose, say }: TagDialogProps) {
  return (
    <Dialog open={target !== null} title="Tags" onOpenChange={(open) => !open && onClose()} actions={[{ label: 'Done', primary: true, onClick: onClose }]}>
      {target !== null && (
        <div className={styles.body}>
          <p className={styles.what}>{target.ids.length > 1 ? `${target.ids.length} readings` : target.title}</p>
          <TagEditor tags={tags} documentIds={target.ids} say={say} autoFocus onCancel={onClose} />
        </div>
      )}
    </Dialog>
  );
}
