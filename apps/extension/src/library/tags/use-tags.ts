// The tag list and each reading's tags, kept up to date: any change to tags (here, in another tab, or by the categoriser
// working in the background) asks again a moment later.
import type { DocumentId } from '@sop/core';
import { useEffect, useMemo, useState } from 'react';
import type { ReadingTag, TagsData, TagSummary } from './tags-data';

/** Changes come in bursts (the categoriser tags a pile of readings): one fetch for each burst. */
const SETTLE_MS = 80;

function useRefreshing<T>(tags: TagsData | null, key: string, load: (tags: TagsData) => Promise<T>): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (tags === null) {
      setValue(null);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fetch = () =>
      void load(tags).then(
        (v) => live && setValue(v),
        () => {}, // the list keeps what it showed; the next change asks again
      );
    fetch();
    const stop = tags.onTagsChange(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(fetch, SETTLE_MS);
    });
    return () => {
      live = false;
      stop();
      if (timer !== null) clearTimeout(timer);
    };
    // `load` is rebuilt every render; `key` says when what it loads has changed.
  }, [tags, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return value;
}

/** Every tag with its count; null until the first answer. */
export function useTagList(tags: TagsData | null): TagSummary[] | null {
  return useRefreshing(tags, 'all', (t) => t.listTags());
}

const NO_TAGS = new Map<DocumentId, ReadingTag[]>();

/** The tags of these readings (none for a reading that has none). */
export function useReadingTags(tags: TagsData | null, ids: readonly DocumentId[]): ReadonlyMap<DocumentId, ReadingTag[]> {
  const key = useMemo(() => [...ids].sort().join(','), [ids]);
  const value = useRefreshing(tags, key, (t) => t.tagsOfMany(ids));
  return value ?? NO_TAGS;
}

/** The readings that carry a tag, or null when no tag is asked for (and while the answer for this tag is on its way). */
export function useTagReadings(tags: TagsData | null, tagId: string | null): ReadonlySet<DocumentId> | null {
  const value = useRefreshing(tags, `tag:${tagId ?? ''}`, async (t) => ({ tagId, ids: tagId === null ? null : new Set(await t.readingsByTag(tagId)) }));
  return tagId !== null && value?.tagId === tagId ? value.ids : null;
}
