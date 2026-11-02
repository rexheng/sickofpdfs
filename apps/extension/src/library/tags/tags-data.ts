// What the library's tag screens read and change (spec R92): the tag list with counts, each reading's tags, the owner's
// changes (add, remove, keep an auto tag, rename, merge, delete) and smart sorting (group by, related readings). The store
// does the work (store/tags-api.ts); this is the library's view of it, so the pages never talk to the store directly.
import type { DocumentId } from '@sop/core';
import type { StoreChange } from '../../store/change-bus';
import type { StoreClient } from '../../store/client';
import type { GroupBy, ReadingTag, TagGroup, TagSummary } from '../../store/tags-api';

export type { GroupBy, ReadingTag, TagGroup, TagSummary };

export interface TagsData {
  /** Every tag with how many readings carry it. */
  listTags(this: void): Promise<TagSummary[]>;
  /** The tags of many readings at once, for rows and cards. A reading with none is left out. */
  tagsOfMany(this: void, documentIds: readonly DocumentId[]): Promise<Map<DocumentId, ReadingTag[]>>;
  tagsOf(this: void, documentId: DocumentId): Promise<ReadingTag[]>;
  /** Gives a reading a tag by name (a new name makes a new tag). An auto tag of that name becomes the owner's own. */
  addTag(this: void, documentId: DocumentId, name: string): Promise<ReadingTag>;
  /** Takes a tag off a reading. The categoriser never puts it back there. */
  removeTag(this: void, documentId: DocumentId, tagId: string): Promise<void>;
  /** An auto tag becomes the owner's own. */
  keepAutoTag(this: void, documentId: DocumentId, tagId: string): Promise<void>;
  renameTag(this: void, tagId: string, name: string): Promise<void>;
  mergeTags(this: void, fromId: string, intoId: string): Promise<void>;
  deleteTag(this: void, tagId: string): Promise<void>;
  readingsByTag(this: void, tagId: string): Promise<DocumentId[]>;
  groupBy(this: void, by: GroupBy): Promise<TagGroup[]>;
  /** The readings closest in meaning, closest first. */
  related(this: void, documentId: DocumentId, n?: number): Promise<DocumentId[]>;
  /** Calls `cb` after anything that changes tags or their counts, from any tab or from the categoriser. */
  onTagsChange(this: void, cb: () => void): () => void;
}

/** Store changes that change a tag, a reading's tags, or a count (a reading moved to Trash or back, or forgotten). */
const TAG_TABLES: ReadonlySet<StoreChange['table']> = new Set(['tags', 'reading_tags', 'auto_tag_removed', 'documents']);

/** The store answers at most this many readings in one `tagsOfMany` call. */
const BATCH = 500;

export function createStoreTagsData(client: StoreClient): TagsData {
  return {
    listTags: () => client.listTags(),
    async tagsOfMany(ids) {
      const out = new Map<DocumentId, ReadingTag[]>();
      for (let i = 0; i < ids.length; i += BATCH) {
        const part = await client.tagsOfMany(ids.slice(i, i + BATCH));
        for (const [id, list] of Object.entries(part)) out.set(id as DocumentId, list);
      }
      return out;
    },
    tagsOf: (id) => client.tagsOf(id),
    addTag: (id, name) => client.addTag(id, name),
    removeTag: (id, tagId) => client.removeTag(id, tagId),
    keepAutoTag: (id, tagId) => client.keepAutoTag(id, tagId),
    renameTag: (tagId, name) => client.renameTag(tagId, name),
    mergeTags: (from, into) => client.mergeTags(from, into),
    deleteTag: (tagId) => client.deleteTag(tagId),
    readingsByTag: (tagId) => client.readingsByTag(tagId),
    groupBy: (by) => client.groupBy(by),
    related: (id, n) => client.related(id, n),
    onTagsChange: (cb) => client.onChange((c) => TAG_TABLES.has(c.table) && cb()),
  };
}

/**
 * The plain sentence in a store refusal, for the owner ("A tag with that name already exists. Merge them instead."), or
 * `fallback` when the refusal is not one the owner can act on.
 */
export function plainRefusal(e: unknown, fallback: string): string {
  const message = e instanceof Error ? e.message : '';
  const m = /^(tag-exists|bad-input): (.+)$/su.exec(message);
  if (m === null) return fallback;
  const text = (m[2] ?? '').trim();
  return /^[A-Z]/u.test(text) ? text : fallback;
}
