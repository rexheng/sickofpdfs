// Smart sorting (R92): My library grouped by topic, course, tag or kind. Within a group the most recently opened comes
// first (the store's order); readings that fit nowhere come last ("No topic"). A reading with several tags is in several
// groups. Each group can be folded away; the choice of grouping is remembered in this browser.
import type { DocumentId } from '@sop/core';
import type { CollectionEntry } from '@sop/ui/library';
import { useCallback, useEffect, useState } from 'react';
import type { GroupBy, TagGroup, TagsData } from './tags-data';

export type Grouping = 'none' | GroupBy;

export const GROUPINGS: readonly Grouping[] = ['none', 'topic', 'course', 'tag', 'kind'];
export const GROUPING_LABELS: Record<Grouping, string> = { none: 'None', topic: 'Topic', course: 'Course', tag: 'Tag', kind: 'Kind' };

const KEY = 'sop-library-group-by';

function readGrouping(): Grouping {
  try {
    const v = localStorage.getItem(KEY);
    return GROUPINGS.find((g) => g === v) ?? 'none';
  } catch {
    return 'none';
  }
}

/** The grouping My library shows, remembered in this browser, and which groups are folded away. */
export function useGrouping(): { grouping: Grouping; setGrouping(this: void, g: Grouping): void; collapsed: ReadonlySet<string>; toggle(this: void, id: string): void } {
  const [grouping, set] = useState<Grouping>(readGrouping);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const setGrouping = useCallback((g: Grouping) => {
    set(g);
    setCollapsed(new Set());
    try {
      localStorage.setItem(KEY, g);
    } catch {
      // kept for this tab only
    }
  }, []);
  const toggle = useCallback(
    (id: string) =>
      setCollapsed((s) => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  return { grouping, setGrouping, collapsed, toggle };
}

/** The store's groups for this grouping, asked again when tags or the readings change. Null while they load. */
export function useGroups(tags: TagsData | null, grouping: Grouping, readingsVersion: unknown): TagGroup[] | null {
  const [groups, setGroups] = useState<{ grouping: Grouping; list: TagGroup[] } | null>(null);
  useEffect(() => {
    if (tags === null || grouping === 'none') return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () =>
      void tags.groupBy(grouping).then(
        (list) => live && setGroups({ grouping, list }),
        () => {},
      );
    load();
    const stop = tags.onTagsChange(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(load, 120);
    });
    return () => {
      live = false;
      stop();
      if (timer !== null) clearTimeout(timer);
    };
  }, [tags, grouping, readingsVersion]);
  return groups !== null && groups.grouping === grouping ? groups.list : null;
}

/** A grouped entry's key: the group and the reading, since a reading can be in several groups. */
export const groupedKey = (group: string, id: DocumentId): string => `${group}|${id}`;

/**
 * The list's lines for these groups: a heading with its count, then its readings (none while it is folded). Only readings
 * that are shown (`byId`: loaded, and through the search and filters) are listed; a group left with none is not shown.
 */
export function groupEntries<T>(groups: readonly TagGroup[], byId: ReadonlyMap<DocumentId, T>, collapsed: ReadonlySet<string>): CollectionEntry<T>[] {
  const out: CollectionEntry<T>[] = [];
  for (const g of groups) {
    const items = g.documentIds.flatMap((id) => {
      const item = byId.get(id);
      return item === undefined ? [] : [{ id, item }];
    });
    if (items.length === 0) continue;
    const folded = collapsed.has(g.key);
    out.push({ kind: 'section', id: g.key, label: g.label, count: items.length, collapsed: folded });
    if (!folded) for (const { id, item } of items) out.push({ kind: 'item', key: groupedKey(g.key, id), item });
  }
  return out;
}
