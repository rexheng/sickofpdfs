// `tag:` and `course:` in the Ctrl+K palette (R92). `tag:deep` keeps the hits from readings with a tag whose name has a word
// starting "deep" (any kind: your tags, courses and topics); `course:14.01` does the same for courses only. While the value
// is typed, the matching tags are suggested; Enter or a click puts one in the field. A name that matches exactly wins
// over the ones that only start the same way.
import type { DocumentId } from '@sop/core';
import { type PaletteSuggestion, registerPaletteOperator } from '../../shared/palette';
import { bareName, fold, KIND_WORD, readingsCount, TAG_ICON, tagMatches } from './tag-format';
import type { TagsData, TagSummary } from './tags-data';

type TagStore = Pick<TagsData, 'listTags' | 'readingsByTag'>;

/** The most suggestions shown. */
const SUGGESTED = 6;

const clean = (value: string): string => value.replace(/^"|"$/gu, '').trim();

function pick(list: readonly TagSummary[], value: string, nameOf: (t: TagSummary) => string): TagSummary[] {
  const v = clean(value);
  const exact = list.filter((t) => fold(nameOf(t)) === fold(v) || fold(t.name) === fold(v));
  return exact.length > 0 ? exact : list.filter((t) => tagMatches(nameOf(t), v));
}

function operator(key: 'tag' | 'course', store: TagStore) {
  const among = (list: readonly TagSummary[]) => (key === 'course' ? list.filter((t) => t.kind === 'course') : list);
  const nameOf = (t: TagSummary) => (key === 'course' ? bareName(t.name) : t.name);
  return {
    key,
    heading: key === 'course' ? 'Courses' : 'Tags',
    async readings(value: string): Promise<ReadonlySet<DocumentId>> {
      const tags = pick(among(await store.listTags()), value, nameOf);
      const sets = await Promise.all(tags.map((t) => store.readingsByTag(t.id)));
      return new Set(sets.flat());
    },
    async suggest(partial: string): Promise<PaletteSuggestion[]> {
      const typed = fold(clean(partial));
      const list = among(await store.listTags()).filter((t) => t.count > 0 && tagMatches(nameOf(t), typed));
      // A name that starts with what was typed first ("econ": Economics before Applied Econometrics), then the most used.
      const starts = (t: TagSummary) => Number(fold(nameOf(t)).startsWith(typed));
      list.sort((a, b) => starts(b) - starts(a) || b.count - a.count || nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base', numeric: true }));
      return list.slice(0, SUGGESTED).map((t) => ({ value: nameOf(t), label: t.name, detail: `${KIND_WORD[t.kind]} · ${readingsCount(t.count)}`, icon: TAG_ICON[t.kind] }));
    },
  };
}

/** Makes `tag:` and `course:` mean something in the palette, over this store. Returns the function that takes them away. */
export function registerTagOperators(store: TagStore): () => void {
  const offs = [registerPaletteOperator(operator('tag', store)), registerPaletteOperator(operator('course', store))];
  return () => {
    for (const off of offs) off();
  };
}
