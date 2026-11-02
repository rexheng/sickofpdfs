// How a tag is shown: its icon, the word for its kind, and the order of lists.
import type { IconName } from '@sop/ui';
import type { ReadingTag, TagSummary } from './tags-data';

type Kind = TagSummary['kind'];

/** A course (school), a topic the categoriser found (category), or the owner's own tag (a price tag, as Gmail's labels). */
export const TAG_ICON: Record<Kind, IconName> = { course: 'school', topic: 'category', tag: 'sell' };

/** "Course", "Topic", "Tag": said after a tag's name in menus and tooltips. */
export const KIND_WORD: Record<Kind, string> = { course: 'Course', topic: 'Topic', tag: 'Tag' };

const COURSE_PREFIX = 'Course: ';

/** A course tag's code ("EC1A1" for "Course: EC1A1"); any other tag's name as it is. */
export function bareName(name: string): string {
  return name.startsWith(COURSE_PREFIX) ? name.slice(COURSE_PREFIX.length) : name;
}

const ORDER: Record<Kind, number> = { tag: 0, course: 1, topic: 2 };
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

/** The left column's order: the owner's own tags, then courses, then topics, each A to Z. */
export function navOrder(list: readonly TagSummary[]): TagSummary[] {
  return [...list].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || byName(a.name, b.name));
}

/** A reading's tags as chips: the owner's first, then the auto ones (the store's order), each group A to Z. */
export function chipOrder(list: readonly ReadingTag[]): ReadingTag[] {
  return [...list].sort((a, b) => Number(b.source === 'owner') - Number(a.source === 'owner') || ORDER[a.kind] - ORDER[b.kind] || byName(a.name, b.name));
}

/** The words of a tag search: a tag matches when every word starts a word of its name (any case, accents ignored). */
export function tagMatches(name: string, typed: string): boolean {
  const words = fold(typed).split(/[\s:·]+/u).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fold(name).split(/[\s:·]+/u).filter(Boolean);
  return words.every((w) => hay.some((h) => h.startsWith(w)));
}

export const fold = (s: string): string => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** "1 reading", "5 readings". */
export const readingsCount = (n: number): string => (n === 1 ? '1 reading' : `${n} readings`);

/** Joins class names, skipping the empty ones. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}
