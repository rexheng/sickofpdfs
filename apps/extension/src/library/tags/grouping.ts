// Smart sorting (R92): My library grouped by topic, course, tag or kind. Within a group the most recently opened comes
// first (the store's order); readings that fit nowhere come last ("No topic"). A reading with several tags is in several
// groups. Each group can be folded away; the choice of grouping is remembered in this browser.
//
// Group by Course uses the Courses page's grouping (8.5b: courses/group.ts over the same `course.<id>` and `course.of.<sha>`
// rows), so the two always agree: a course has the name the owner gave it, merged courses are one group, and a reading the
// owner moved is where they put it. Private readings are never in a course; they are under "No course".
import type { DocumentId } from '@sop/core';
import type { CollectionEntry } from '@sop/ui/library';
import { useCallback, useEffect, useState } from 'react';
import type { CoursesData } from '../courses/courses-data';
import { groupByCourse } from '../courses/group';
import type { GroupBy, ReadingTag, TagGroup, TagsData } from './tags-data';

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

/** A group of the list. `rest`: it holds every shown reading that no other group holds ("No course"). */
export type ListGroup = TagGroup & { rest?: boolean };

const byLabel = (a: ListGroup, b: ListGroup): number =>
  b.documentIds.length - a.documentIds.length || a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }) || (a.key < b.key ? -1 : 1);

/** The courses as groups: the Courses page's own grouping, the biggest first (as the store orders its groups), then "No course". */
async function courseGroups(courses: CoursesData): Promise<ListGroup[]> {
  const { courses: list, loose } = groupByCourse(await courses.listCourseInputs());
  const groups: ListGroup[] = list.map((c) => ({ key: c.key, label: c.name, tagId: null, documentIds: [...c.readings] }));
  return [...groups.sort(byLabel), { key: 'none', label: 'No course', tagId: null, documentIds: loose, rest: true }];
}

/**
 * The groups for this grouping, asked again when tags, courses or the readings change. Null while they load. Courses come from
 * the Courses page's rows when `courses` is given; every other grouping from the store's `groupBy`.
 */
export function useGroups(tags: TagsData | null, grouping: Grouping, readingsVersion: unknown, courses: CoursesData | null = null): ListGroup[] | null {
  const [groups, setGroups] = useState<{ grouping: Grouping; list: ListGroup[] } | null>(null);
  useEffect(() => {
    if (tags === null || grouping === 'none') return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ask = (): Promise<ListGroup[]> => (grouping === 'course' && courses !== null ? courseGroups(courses) : tags.groupBy(grouping));
    const load = () =>
      void ask().then(
        (list) => live && setGroups({ grouping, list }),
        () => {},
      );
    load();
    const soon = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(load, 120);
    };
    const stopTags = tags.onTagsChange(soon);
    const stopCourses = grouping === 'course' && courses !== null ? courses.onCoursesChange(soon) : () => {};
    return () => {
      live = false;
      stopTags();
      stopCourses();
      if (timer !== null) clearTimeout(timer);
    };
  }, [tags, courses, grouping, readingsVersion]);
  return groups !== null && groups.grouping === grouping ? groups.list : null;
}

/**
 * A reading's chips under a group heading. Grouped by course, its course chips go: the heading names its course, and a chip
 * would show the code the course was found by, not the name the owner gave it.
 */
export function chipsUnder(grouping: Grouping, list: readonly ReadingTag[]): readonly ReadingTag[] {
  return grouping === 'course' ? list.filter((t) => t.kind !== 'course') : list;
}

/** A grouped entry's key: the group and the reading, since a reading can be in several groups. */
export const groupedKey = (group: string, id: DocumentId): string => `${group}|${id}`;

/** The group of a grouped entry's key (for a tag, a course or a topic group: its tag id); null for a key with no group. */
export function groupOfKey(key: string): string | null {
  const at = key.lastIndexOf('|');
  return at < 0 ? null : key.slice(0, at);
}

/**
 * The list's lines for these groups: a heading with its count, then its readings (none while it is folded). Only readings
 * that are shown (`byId`: loaded, and through the search and filters) are listed; a group left with none is not shown.
 */
export function groupEntries<T>(groups: readonly ListGroup[], byId: ReadonlyMap<DocumentId, T>, collapsed: ReadonlySet<string>): CollectionEntry<T>[] {
  const out: CollectionEntry<T>[] = [];
  const held = new Set<DocumentId>(groups.flatMap((g) => (g.rest === true ? [] : g.documentIds)));
  for (const g of groups) {
    // A `rest` group: its own readings, then every other shown reading no group holds (a private one, say), in the list's order.
    const ids = g.rest === true ? [...new Set([...g.documentIds.filter((id) => !held.has(id)), ...[...byId.keys()].filter((id) => !held.has(id))])] : g.documentIds;
    const items = ids.flatMap((id) => {
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
