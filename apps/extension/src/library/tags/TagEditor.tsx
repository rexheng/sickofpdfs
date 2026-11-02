// The tags of one reading or of several at once (R92), as the Tags dialog and the details panel show them:
// - "Add a tag", with the tags you have as suggestions;
// - your own tags as chips, each with a cross to take it off (with several readings: "2 of 3", and a plus to give it to all);
// - "Added for you": the auto tags, lighter and marked "auto", each with Keep and Remove. A removed auto tag never comes back
//   on that reading.
import type { DocumentId } from '@sop/core';
import { IconButton, TextButton } from '@sop/ui';
import { useCallback, useMemo } from 'react';
import { TagInput } from './TagInput';
import { TagLabel } from './TagChip';
import styles from './TagEditor.module.css';
import { chipOrder } from './tag-format';
import { plainRefusal, type ReadingTag, type TagsData } from './tags-data';
import { useReadingTags, useTagList } from './use-tags';

export interface TagEditorProps {
  tags: TagsData;
  documentIds: readonly DocumentId[];
  /** A short message at the bottom of the window, with an Undo when there is one. */
  say(this: void, text: string, undo?: () => void): void;
  autoFocus?: boolean;
  /** Where Esc in the empty field goes (the dialog closes). */
  onCancel?(this: void): void;
}

/** One tag across the readings asked about: who has it as their own, and who has it as auto. */
interface Gathered {
  tag: ReadingTag;
  owner: DocumentId[];
  auto: DocumentId[];
}

const FAILED = 'That didn’t work. Try again.';

export function TagEditor({ tags, documentIds, say, autoFocus = false, onCancel }: TagEditorProps) {
  const all = useTagList(tags);
  const byReading = useReadingTags(tags, documentIds);
  const many = documentIds.length > 1;

  const gathered = useMemo(() => {
    const map = new Map<string, Gathered>();
    for (const id of documentIds) {
      for (const t of byReading.get(id) ?? []) {
        const g = map.get(t.tagId) ?? { tag: t, owner: [], auto: [] };
        (t.source === 'owner' ? g.owner : g.auto).push(id);
        map.set(t.tagId, g);
      }
    }
    return chipOrder([...map.values()].map((g) => g.tag)).map((t) => map.get(t.tagId) as Gathered);
  }, [byReading, documentIds]);

  const owned = gathered.filter((g) => g.owner.length > 0);
  const autos = gathered.filter((g) => g.auto.length > 0);
  // A tag every reading has already is not suggested again.
  const exclude = useMemo(() => new Set(gathered.filter((g) => g.owner.length === documentIds.length).map((g) => g.tag.tagId)), [gathered, documentIds.length]);

  const each = useCallback(async (ids: readonly DocumentId[], f: (id: DocumentId) => Promise<unknown>) => {
    for (const id of ids) await f(id);
  }, []);

  const add = (name: string) => {
    void each(documentIds, (id) => tags.addTag(id, name)).then(
      () => say(many ? `Tagged ${documentIds.length} readings “${name}”` : `Tagged “${name}”`),
      (e: unknown) => say(plainRefusal(e, FAILED)),
    );
  };
  const removeOwn = (g: Gathered) => {
    const from = [...g.owner];
    void each(from, (id) => tags.removeTag(id, g.tag.tagId)).then(
      () => say(`Removed “${g.tag.name}”`, () => void each(from, (id) => tags.addTag(id, g.tag.name)).catch(() => say(FAILED))),
      () => say(FAILED),
    );
  };
  const giveAll = (g: Gathered) => {
    const to = documentIds.filter((id) => !g.owner.includes(id));
    void each(to, (id) => tags.addTag(id, g.tag.name)).then(
      () => say(`Tagged ${documentIds.length} readings “${g.tag.name}”`),
      () => say(FAILED),
    );
  };
  const keep = (g: Gathered) => {
    void each(g.auto, (id) => tags.keepAutoTag(id, g.tag.tagId)).then(
      () => say(`Kept “${g.tag.name}”`),
      () => say(FAILED),
    );
  };
  const removeAuto = (g: Gathered) => {
    const from = [...g.auto];
    void each(from, (id) => tags.removeTag(id, g.tag.tagId)).then(
      () => say(`Removed “${g.tag.name}”. It won’t be added to ${from.length === 1 ? 'this reading' : 'these readings'} again.`, () => void each(from, (id) => tags.addTag(id, g.tag.name)).catch(() => say(FAILED))),
      () => say(FAILED),
    );
  };

  const of = (n: number) => (many && n < documentIds.length ? `${n} of ${documentIds.length}` : undefined);

  return (
    <div className={styles.editor}>
      <TagInput all={all} exclude={exclude} onAdd={add} autoFocus={autoFocus} {...(onCancel !== undefined ? { onCancel } : {})} />
      {owned.length > 0 ? (
        <ul className={styles.chips} aria-label={many ? 'Tags on these readings' : 'Tags on this reading'}>
          {owned.map((g) => {
            const note = of(g.owner.length);
            return (
              <li key={g.tag.tagId} className={styles.chipItem}>
                <TagLabel tag={{ ...g.tag, source: 'owner' }} {...(note !== undefined ? { note } : {})} className={styles.ownChip} />
                {note !== undefined && <IconButton icon="add" size={32} label={`Give “${g.tag.name}” to all ${documentIds.length}`} onClick={() => giveAll(g)} className={styles.chipButton} />}
                <IconButton icon="close" size={32} label={`Remove “${g.tag.name}”`} onClick={() => removeOwn(g)} className={styles.chipButton} />
              </li>
            );
          })}
        </ul>
      ) : (
        autos.length === 0 && <p className={styles.empty}>{many ? 'These readings have no tags yet.' : 'No tags yet.'} Type a word above to add one.</p>
      )}
      {autos.length > 0 && (
        <section className={styles.autoSection} aria-label="Added for you">
          <p className={styles.autoHeading}>Added for you</p>
          <p className={styles.autoHint}>sickofpdfs added these by itself. Keep the ones that fit.</p>
          <ul className={styles.autoList}>
            {autos.map((g) => {
              const note = of(g.auto.length);
              return (
                <li key={g.tag.tagId} className={styles.autoRow}>
                  <TagLabel tag={{ ...g.tag, source: 'auto' }} {...(note !== undefined ? { note } : {})} className={styles.autoChip} />
                  <span className={styles.autoActions}>
                    <TextButton label="Keep" aria-label={`Keep “${g.tag.name}”`} onClick={() => keep(g)} />
                    <TextButton label="Remove" aria-label={`Remove “${g.tag.name}”`} onClick={() => removeAuto(g)} />
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
