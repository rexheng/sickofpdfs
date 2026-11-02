// A tag's own menu in the left column (and on its page): Rename, Merge into another tag, Delete (R92: "Tags can be
// renamed, merged and deleted"). A rename sticks: the categoriser never renames that tag again.
import { Dialog, Icon, type MenuItemDef, TextField } from '@sop/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import styles from './TagManage.module.css';
import { cx, KIND_WORD, navOrder, readingsCount, TAG_ICON, tagMatches } from './tag-format';
import { plainRefusal, type TagsData, type TagSummary } from './tags-data';

export type TagAction = 'rename' | 'merge' | 'delete';

/** The tag menu's rows. */
export function tagMenu(tag: TagSummary, run: (action: TagAction) => void, extra: MenuItemDef[] = []): MenuItemDef[] {
  return [
    ...extra,
    ...(extra.length > 0 ? [{ kind: 'separator' } as const] : []),
    { kind: 'item', id: 'rename', label: 'Rename', icon: 'edit', onSelect: () => run('rename') },
    { kind: 'item', id: 'merge', label: 'Merge into another tag…', icon: 'call_merge', onSelect: () => run('merge') },
    { kind: 'separator' },
    { kind: 'item', id: 'delete', label: 'Delete tag', icon: 'delete', onSelect: () => run('delete') },
  ];
}

export interface TagManageProps {
  tags: TagsData;
  /** Every tag (to merge into); null while loading. */
  all: readonly TagSummary[] | null;
  /** What to do, to which tag; null: nothing open. */
  open: { action: TagAction; tag: TagSummary } | null;
  onClose(this: void): void;
  say(this: void, text: string, undo?: () => void): void;
  /** After the tag went away (merged or deleted): where to go now (the page that showed it). */
  onGone?(this: void, tagId: string, mergedInto: string | null): void;
}

const FAILED = 'That didn’t work. Try again.';

export function TagManage({ tags, all, open, onClose, say, onGone }: TagManageProps) {
  return (
    <>
      <RenameTag tags={tags} tag={open?.action === 'rename' ? open.tag : null} onClose={onClose} say={say} />
      <MergeTag tags={tags} all={all} tag={open?.action === 'merge' ? open.tag : null} onClose={onClose} say={say} onGone={onGone} />
      <DeleteTag tags={tags} tag={open?.action === 'delete' ? open.tag : null} onClose={onClose} say={say} onGone={onGone} />
    </>
  );
}

function RenameTag({ tags, tag, onClose, say }: { tags: TagsData; tag: TagSummary | null; onClose(this: void): void; say: TagManageProps['say'] }) {
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (tag === null) return;
    setValue(tag.name);
    setProblem(null);
    requestAnimationFrame(() => field.current?.select());
  }, [tag]);
  const clean = value.trim();
  const save = () => {
    if (tag === null || clean === '') return;
    if (clean === tag.name) {
      onClose();
      return;
    }
    tags.renameTag(tag.id, clean).then(
      () => {
        onClose();
        say(`Renamed to “${clean}”`);
      },
      (e: unknown) => setProblem(plainRefusal(e, FAILED)),
    );
  };
  return (
    <Dialog
      open={tag !== null}
      title="Rename tag"
      onOpenChange={(next) => !next && onClose()}
      actions={[
        { label: 'Cancel', onClick: onClose },
        { label: 'Rename', primary: true, onClick: save, disabled: clean === '' },
      ]}
    >
      <div className={styles.body}>
        <TextField ref={field} label="New name" value={value} onChange={(v) => {
            setValue(v);
            setProblem(null);
          }} onEnter={save} invalid={clean === '' || problem !== null} maxLength={60} />
        {tag !== null && tag.kind !== 'tag' && <p className={styles.note}>The new name stays. sickofpdfs won’t rename this {KIND_WORD[tag.kind].toLowerCase()} again.</p>}
        {problem !== null && (
          <p className={styles.problem} role="alert">
            {problem}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function MergeTag({ tags, all, tag, onClose, say, onGone }: { tags: TagsData; all: readonly TagSummary[] | null; tag: TagSummary | null; onClose(this: void): void; say: TagManageProps['say']; onGone: TagManageProps['onGone'] }) {
  const [find, setFind] = useState('');
  const [into, setInto] = useState<string | null>(null);
  useEffect(() => {
    setFind('');
    setInto(null);
  }, [tag]);
  const others = useMemo(() => navOrder((all ?? []).filter((t) => t.id !== tag?.id && tagMatches(t.name, find))), [all, tag, find]);
  const target = others.find((t) => t.id === into) ?? null;
  const merge = () => {
    if (tag === null || target === null) return;
    tags.mergeTags(tag.id, target.id).then(
      () => {
        onClose();
        say(`Merged “${tag.name}” into “${target.name}”`);
        onGone?.(tag.id, target.id);
      },
      () => say(FAILED),
    );
  };
  return (
    <Dialog
      open={tag !== null}
      title="Merge into another tag"
      onOpenChange={(next) => !next && onClose()}
      actions={[
        { label: 'Cancel', onClick: onClose },
        { label: 'Merge', primary: true, onClick: merge, disabled: target === null },
      ]}
    >
      {tag !== null && (
        <div className={styles.body}>
          <p className={styles.note}>
            Every reading tagged “{tag.name}” gets the tag you pick. Then “{tag.name}” goes away.
          </p>
          <TextField label="Find a tag" type="search" value={find} onChange={setFind} />
          <div className={styles.choices} role="radiogroup" aria-label="Merge into">
            {others.length === 0 && <p className={styles.note}>No other tag has those words.</p>}
            {others.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={into === t.id}
                className={cx(styles.choice, into === t.id && styles.chosen)}
                onClick={() => setInto(t.id)}
              >
                <Icon name={into === t.id ? 'radio_button_checked' : 'radio_button_unchecked'} size={20} />
                <Icon name={TAG_ICON[t.kind]} size={20} />
                <span className={styles.choiceName}>{t.name}</span>
                <span className={styles.choiceCount}>{t.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function DeleteTag({ tags, tag, onClose, say, onGone }: { tags: TagsData; tag: TagSummary | null; onClose(this: void): void; say: TagManageProps['say']; onGone: TagManageProps['onGone'] }) {
  const remove = () => {
    if (tag === null) return;
    tags.deleteTag(tag.id).then(
      () => {
        onClose();
        say(`Deleted the tag “${tag.name}”`);
        onGone?.(tag.id, null);
      },
      () => say(FAILED),
    );
  };
  return (
    <Dialog
      open={tag !== null}
      title="Delete this tag?"
      onOpenChange={(next) => !next && onClose()}
      actions={[
        { label: 'Cancel', onClick: onClose },
        { label: 'Delete', primary: true, onClick: remove },
      ]}
    >
      {tag !== null && (
        <div className={styles.body}>
          <p className={styles.note}>
            “{tag.name}” comes off {tag.count === 0 ? 'every reading' : readingsCount(tag.count)}. The readings stay in your library.
          </p>
          {tag.kind !== 'tag' && <p className={styles.note}>sickofpdfs won’t add this {KIND_WORD[tag.kind].toLowerCase()} again.</p>}
        </div>
      )}
    </Dialog>
  );
}
