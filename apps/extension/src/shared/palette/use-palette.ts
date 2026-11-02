// What the palette shows for what was typed and the filters that are on. A search starts the moment a key is pressed. Only
// one runs at a time: keys pressed while it runs are folded into one more search for the newest text, so the store is
// never queued up with words the reader has already typed over, and the list never shows an old answer after a newer one.
import type { DocumentId, DocumentRow } from '@sop/core';
import type { IconName } from '@sop/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { shownTitle } from '../shown-title';
import type { LibraryFilter, LibraryItem, SearchHit } from '../../store/library-api';
import { type Filters, NO_FILTERS, toQueryFilter } from '../../library/components/filters';
import { completeOperator, matchScore, operatorBeingTyped, type PaletteSuggestion, parseQuery, plain, plainOf, queryTerms, splitMarked } from './query';
import type { PaletteCommand, PaletteCommandGroup, PaletteStore, PaletteTarget, TextPart } from './types';

/** The most hits one search asks for. The store shares them fairly between readings, pages and notes. */
const SEARCH_LIMIT = 24;
/** With a `tag:` style word, hits are narrowed here after the search, so more are asked for. */
const NARROWED_LIMIT = 200;
/** The most rows of each group shown. */
const GROUP_LIMIT = 12;
/** A reading with many matching pages shows this many first; the readings after it are not pushed out of the list. */
const PER_READING = 3;
/** With nothing typed: how many recent readings, and how many commands, are shown. */
const RECENT_SHOWN = 5;
const COMMANDS_SHOWN = 5;

export type PaletteGroupId = 'suggest' | 'recent' | 'readings' | 'pages' | 'notes' | 'commands';

export interface PaletteRow {
  key: string;
  icon: IconName | 'pdf';
  title: TextPart[];
  /** The second line; empty for a command. */
  detail: TextPart[];
  /** At the right: the keys of a command. */
  trail: string | null;
  /** A command or a place to go: one short line. */
  compact: boolean;
  target: PaletteTarget | null;
  command: PaletteCommand | null;
  /** S18: a `tag:` or `course:` suggestion: choosing it puts this text in the field instead of opening anything. */
  complete?: string | null;
}

export interface PaletteGroup {
  id: PaletteGroupId;
  heading: string;
  rows: PaletteRow[];
}

/** The filter chips: starred, and the library's own Type, Has notes and Last opened. */
export interface PaletteFilters extends Filters {
  starred: boolean;
}

export const NO_PALETTE_FILTERS: PaletteFilters = { ...NO_FILTERS, starred: false };

export const isNarrowed = (f: PaletteFilters): boolean => f.starred || f.hasNotes || f.opened !== null || f.kinds.length > 0;

function libraryFilter(f: PaletteFilters): LibraryFilter | undefined {
  const out: LibraryFilter = toQueryFilter(f);
  if (f.starred) out.starred = true;
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The title and the authors of a reading, kept so a hit on one of its pages can say whose page it is. */
interface Described {
  title: string;
  authors: string;
}

function authorsLine(doc: DocumentRow): string {
  const names = doc.authors.slice(0, 3).join(', ') + (doc.authors.length > 3 ? ' and others' : '');
  const parts = [names, doc.year === null ? '' : String(doc.year)].filter((p) => p !== '');
  return parts.length > 0 ? parts.join(' · ') : `${doc.pageCount} ${doc.pageCount === 1 ? 'page' : 'pages'}`;
}

interface Answer {
  /** The words searched for (the operators taken out). */
  terms: string[];
  /** S18: what the `tag:` or `course:` being typed could be, with the text each one completes to. */
  suggestions: { heading: string; items: { s: PaletteSuggestion; complete: string }[] } | null;
  recent: LibraryItem[] | null;
  hits: SearchHit[];
  described: Map<DocumentId, Described>;
}

interface Request {
  seq: number;
  typed: string;
  filters: PaletteFilters;
}

export interface PaletteView {
  query: string;
  setQuery(this: void, text: string): void;
  filters: PaletteFilters;
  setFilters(this: void, f: PaletteFilters): void;
  groups: PaletteGroup[];
  rows: PaletteRow[];
  /** A search is running (or about to). */
  searching: boolean;
  /** The words were searched and nothing came back. */
  nothingFound: boolean;
  /** The library holds no readings at all (seen with nothing typed). */
  libraryEmpty: boolean;
  /** The store could not answer. */
  failed: boolean;
  /** The row Enter would take. */
  active: number;
  setActive(this: void, i: number): void;
  move(this: void, by: 1 | -1): void;
}

export function usePalette(o: { store: PaletteStore | null; commands: PaletteCommandGroup | null; initialQuery: string }): PaletteView {
  const { store, commands } = o;
  const [query, setQueryState] = useState(o.initialQuery);
  const [filters, setFiltersState] = useState<PaletteFilters>(NO_PALETTE_FILTERS);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const run = useRef<{ latest: number; busy: boolean; queued: Request | null; described: Map<DocumentId, Described> }>({ latest: 0, busy: false, queued: null, described: new Map() });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const describe = useCallback(
    async (ids: readonly DocumentId[]): Promise<Map<DocumentId, Described>> => {
      const known = run.current.described;
      if (store === null) return known;
      await Promise.all(
        ids
          .filter((id) => !known.has(id))
          .map(async (id) => {
            const doc = await store.getDocument(id).catch(() => null);
            if (doc === null) return;
            // An untitled reading is named by its file name, which the last place it was opened from gives.
            const link = doc.title?.trim() ? null : ((await store.listLocations(id).catch(() => [])).sort((a, b) => b.lastSeen - a.lastSeen)[0]?.raw ?? null);
            known.set(id, { title: shownTitle(doc.title, link), authors: authorsLine(doc) });
          }),
      );
      return known;
    },
    [store],
  );

  const answerFor = useCallback(
    async (req: Request): Promise<Answer> => {
      const parsed = parseQuery(req.typed);
      const filter = libraryFilter(req.filters);
      const terms = queryTerms(parsed.text);
      // `tag:` and `course:` (S18) narrow to some readings; the hits are cut down to them after the search.
      const allowed = parsed.operators.length > 0 ? await narrowTo(parsed.operators) : null;
      // While a `tag:` value is typed, its suggestions come first.
      const typing = operatorBeingTyped(req.typed);
      const offered = typing === null ? [] : await (typing.op.suggest?.(typing.partial) ?? Promise.resolve([])).catch(() => []);
      const suggestions =
        typing === null || offered.length === 0 ? null : { heading: typing.op.heading ?? 'Suggestions', items: offered.map((s) => ({ s, complete: completeOperator(req.typed, typing, s.value) })) };
      if (store === null) return { terms, suggestions, recent: null, hits: [], described: new Map() };
      if (parsed.text === '') {
        const page = await store.listDocuments({ view: 'recent', sort: { by: 'lastOpened', dir: 'desc' }, ...(filter ? { filter } : {}), limit: allowed === null ? RECENT_SHOWN : NARROWED_LIMIT });
        const items = allowed === null ? page.items : page.items.filter((i) => allowed.has(i.doc.id)).slice(0, RECENT_SHOWN);
        const described = await describe(items.map((i) => i.doc.id));
        return { terms, suggestions, recent: items, hits: [], described };
      }
      const found = await store.search({ text: parsed.text, ...(filter ? { filter } : {}), limit: allowed === null ? SEARCH_LIMIT : NARROWED_LIMIT });
      const hits = allowed === null ? found : found.filter((h) => allowed.has(h.documentId));
      const described = await describe([...new Set(hits.map((h) => h.documentId))]);
      return { terms, suggestions, recent: null, hits, described };
    },
    [store, describe],
  );

  // One search at a time; what was typed meanwhile is searched next, and only the newest answer is shown.
  const start = useCallback(
    function begin(req: Request): void {
      const r = run.current;
      r.busy = true;
      answerFor(req).then(
        (a) => {
          if (alive.current && req.seq === r.latest) {
            setAnswer(a);
            setFailed(false);
            setSearching(false);
            setActive(0);
          }
        },
        () => {
          if (alive.current && req.seq === r.latest) {
            setFailed(true);
            setSearching(false);
          }
        },
      ).finally(() => {
        r.busy = false;
        const next = r.queued;
        r.queued = null;
        if (alive.current && next !== null) begin(next);
      });
    },
    [answerFor],
  );

  const ask = useCallback(
    (typed: string, f: PaletteFilters) => {
      if (store === null) return;
      const r = run.current;
      const req: Request = { seq: ++r.latest, typed, filters: f };
      setSearching(true);
      if (r.busy) r.queued = req;
      else start(req);
    },
    [store, start],
  );

  // The first search is for the text the palette opened with (nothing: the recent readings), as soon as there is a store.
  const typedNow = useRef({ query, filters });
  useEffect(() => {
    typedNow.current = { query, filters };
  });
  useEffect(() => {
    if (store !== null) ask(typedNow.current.query, typedNow.current.filters);
  }, [store, ask]);

  const setQuery = useCallback(
    (text: string) => {
      typedNow.current = { ...typedNow.current, query: text };
      setQueryState(text);
      ask(text, typedNow.current.filters);
    },
    [ask],
  );
  const setFilters = useCallback(
    (f: PaletteFilters) => {
      typedNow.current = { ...typedNow.current, filters: f };
      setFiltersState(f);
      ask(typedNow.current.query, f);
    },
    [ask],
  );

  const groups = useMemo(() => buildGroups(answer, query, commands), [answer, query, commands]);
  const rows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const move = useCallback((by: 1 | -1) => setActive((i) => (rows.length === 0 ? 0 : (i + by + rows.length) % rows.length)), [rows.length]);

  const typedSomething = query.trim() !== '';
  return {
    query,
    setQuery,
    filters,
    setFilters,
    groups,
    rows,
    searching,
    nothingFound: !searching && !failed && typedSomething && answer !== null && rows.length === 0,
    libraryEmpty: !searching && !typedSomething && answer?.recent?.length === 0 && !isNarrowed(filters),
    failed,
    active: Math.min(active, Math.max(0, rows.length - 1)),
    setActive,
    move,
  };
}

/** The readings every typed operator lets through (an empty set when one lets none). */
async function narrowTo(typed: { op: { readings(value: string): Promise<ReadonlySet<DocumentId>> }; value: string }[]): Promise<ReadonlySet<DocumentId>> {
  const sets = await Promise.all(typed.map((t) => t.op.readings(t.value)));
  return new Set([...sets[0]].filter((id) => sets.every((s) => s.has(id))));
}

// ---- rows -------------------------------------------------------------------------------------------------------------------

function buildGroups(answer: Answer | null, query: string, commands: PaletteCommandGroup | null): PaletteGroup[] {
  const groups: PaletteGroup[] = [];
  const typed = parseQuery(query).text;
  const nameOf = (id: DocumentId): string => answer?.described.get(id)?.title ?? 'This PDF';

  if (answer !== null) {
    if (answer.suggestions !== null) {
      groups.push({
        id: 'suggest',
        heading: answer.suggestions.heading,
        rows: answer.suggestions.items.map(({ s, complete }) => ({
          key: `suggest:${s.value}`,
          icon: s.icon ?? 'sell',
          title: plain(s.label),
          detail: plain(s.detail),
          trail: null,
          compact: false,
          target: null,
          command: null,
          complete,
        })),
      });
    }
    if (answer.recent !== null && answer.recent.length > 0) {
      groups.push({
        id: 'recent',
        heading: 'Recent',
        rows: answer.recent.map((item) => {
          const d = answer.described.get(item.doc.id);
          return readingRow(`recent:${item.doc.id}`, plain(d?.title ?? 'This PDF'), plain(d?.authors ?? ''), item.doc.id);
        }),
      });
    }
    const readings = answer.hits.filter((h): h is Extract<SearchHit, { kind: 'reading' }> => h.kind === 'reading');
    if (readings.length > 0) {
      groups.push({
        id: 'readings',
        heading: 'Readings',
        rows: readings.slice(0, GROUP_LIMIT).map((h) => {
          const d = answer.described.get(h.documentId);
          // The store marks the words in the title, or else in the authors; the title is always the first line.
          const inTitle = plainOf(h.snippet) === h.title.replace(/\s+/gu, ' ').trim();
          return readingRow(`reading:${h.documentId}`, inTitle ? splitMarked(h.snippet) : plain(h.title), inTitle ? plain(d?.authors ?? '') : splitMarked(h.snippet), h.documentId);
        }),
      });
    }
    const pages = answer.hits.filter((h): h is Extract<SearchHit, { kind: 'page' }> => h.kind === 'page');
    if (pages.length > 0) {
      groups.push({
        id: 'pages',
        heading: 'Pages',
        rows: spread(pages).map((h) => ({
          key: `page:${h.documentId}:${h.pageIndex}`,
          icon: 'description',
          title: splitMarked(h.snippet),
          detail: plain(`Page ${h.pageIndex + 1} · ${nameOf(h.documentId)}`),
          trail: null,
          compact: false,
          target: { kind: 'page', documentId: h.documentId, pageIndex: h.pageIndex, terms: answer.terms },
          command: null,
        })),
      });
    }
    const notes = answer.hits.filter((h): h is Extract<SearchHit, { kind: 'note' }> => h.kind === 'note');
    if (notes.length > 0) {
      groups.push({
        id: 'notes',
        heading: 'Notes',
        rows: spread(notes).map((h) => ({
          key: `note:${h.commentId}`,
          icon: 'comment',
          title: splitMarked(h.snippet),
          detail: plain(`${h.author === 'claude' ? 'Claude’s reply' : 'Your note'} · ${h.pageIndex === null ? 'Whole document' : `Page ${h.pageIndex + 1}`} · ${nameOf(h.documentId)}`),
          trail: null,
          compact: false,
          target: { kind: 'note', documentId: h.documentId, threadId: h.threadId, pageIndex: h.pageIndex },
          command: null,
        })),
      });
    }
  }

  if (commands !== null) {
    const matches = commands.commands
      .map((c) => ({ c, score: matchScore(c.label, typed) }))
      .filter((m): m is { c: PaletteCommand; score: number } => m.score !== null)
      .sort((a, b) => a.score - b.score);
    const shown = (typed === '' ? matches.slice(0, COMMANDS_SHOWN) : matches.slice(0, GROUP_LIMIT)).map((m) => m.c);
    if (shown.length > 0) {
      groups.push({
        id: 'commands',
        heading: commands.heading,
        rows: shown.map((c) => ({
          key: `command:${c.id}`,
          icon: c.icon ?? 'keyboard',
          title: plain(c.label),
          detail: [],
          trail: c.keys ?? null,
          compact: true,
          target: null,
          command: c,
        })),
      });
    }
  }
  return groups;
}

/**
 * The hits to show, best first, but with each reading's first few ahead of any reading's later ones. One paper that
 * mentions a word on twenty pages then does not hide the one page of another paper that mentions it.
 */
function spread<T extends { documentId: DocumentId }>(hits: readonly T[]): T[] {
  const seen = new Map<DocumentId, number>();
  const first: T[] = [];
  const later: T[] = [];
  for (const h of hits) {
    const n = seen.get(h.documentId) ?? 0;
    seen.set(h.documentId, n + 1);
    (n < PER_READING ? first : later).push(h);
  }
  return [...first, ...later].slice(0, GROUP_LIMIT);
}

function readingRow(key: string, title: TextPart[], detail: TextPart[], documentId: DocumentId): PaletteRow {
  return { key, icon: 'pdf', title, detail, trail: null, compact: false, target: { kind: 'reading', documentId }, command: null };
}
