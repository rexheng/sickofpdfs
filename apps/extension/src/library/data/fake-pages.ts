// The in-memory notes, reading history and settings behind the fake library (fake.ts), for screenshots and hand checks of
// Home, Notes and Settings (plan S14). Test builds only, like fake.ts: nothing here is written anywhere.
import {
  type Anchor,
  type Author,
  type ClaudeReplyMeta,
  type CommentId,
  type CommentRow,
  type DocumentId,
  exportMarkdown,
  listEntryProblem,
  notesPath,
  type ThreadId,
  type ThreadRow,
} from '@sop/core';
import { shownTitle } from '../../shared/shown-title';
import type { NoteItem, PagesData, ReadingState } from './pages-data';
import { zipNotes } from './pages-data';
import type { LibraryItem } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface NoteSeed {
  /** The reading's title, as fake.ts names it. */
  reading: string;
  page: number | null;
  quote: string | null;
  /** Minutes before "now" each comment was written, root first. */
  comments: { author: Author; body: string; minutesAgo: number }[];
  /** In Trash: minutes before "now" it was deleted. */
  deletedMinutesAgo?: number;
}

const NOTES: readonly NoteSeed[] = [
  {
    reading: 'Attention Is All You Need',
    page: 2,
    quote: 'An attention function can be described as mapping a query and a set of key-value pairs to an output',
    comments: [
      { author: 'me', body: 'This is the core idea. Query, key and value all come from the same sentence in self-attention.', minutesAgo: 75 },
      {
        author: 'claude',
        body: 'Yes. In self-attention each word asks a question (the **query**), every word offers a label (the **key**), and the answer mixes their contents (the **values**), weighted by how well query and key match.',
        minutesAgo: 74,
      },
    ],
  },
  {
    reading: 'Attention Is All You Need',
    page: 5,
    quote: 'we found it beneficial to linearly project the queries, keys and values h times',
    comments: [{ author: 'me', body: 'Why 8 heads? Check the ablation in Table 3 before the seminar.', minutesAgo: 70 }],
  },
  {
    reading: 'Difference-in-Differences with Multiple Time Periods',
    page: 7,
    quote: 'the group-time average treatment effect',
    comments: [
      { author: 'me', body: 'ATT(g,t): the effect for the group first treated in period g, measured in period t. Use this in the essay.', minutesAgo: 3 * 60 + 40 },
    ],
  },
  {
    reading: 'Difference-in-Differences with Multiple Time Periods',
    page: null,
    quote: null,
    comments: [{ author: 'me', body: 'Read for the **week 6** seminar. Focus on the method section and the robustness checks.', minutesAgo: 4 * 60 }],
  },
  {
    reading: 'Deep Residual Learning for Image Recognition',
    page: 1,
    quote: 'we explicitly let these layers fit a residual mapping',
    comments: [
      { author: 'me', body: 'Residual = what is left over. Easier to learn small changes than the whole mapping.', minutesAgo: 26 * 60 },
      { author: 'claude', body: 'Right. If the best mapping is close to "do nothing", the layers only need to push their weights towards zero.', minutesAgo: 26 * 60 - 1 },
      { author: 'me', body: 'Got it, thanks.', minutesAgo: 26 * 60 - 3 },
    ],
  },
  {
    reading: 'Linear Algebra Done Right',
    page: 30,
    quote: 'A list of vectors is called linearly independent',
    comments: [{ author: 'me', body: 'Linearly independent: no vector in the list is a combination of the others.', minutesAgo: 50 * 60 }],
  },
  {
    reading: 'Introduction to Algorithms, Lecture 1: Introduction',
    page: 2,
    quote: 'An algorithm is a procedure mapping each input to a single output',
    comments: [{ author: 'me', body: 'Definition for the exam.', minutesAgo: 75 * 60 }],
  },
  {
    reading: 'Convex Optimization',
    page: 21,
    quote: 'a set C is convex if the line segment between any two points in C lies in C',
    comments: [{ author: 'me', body: 'Draw this one. Picture beats the formula.', minutesAgo: 400 * 60 }],
  },
  {
    reading: 'Attention Is All You Need',
    page: 9,
    quote: 'Table 2: The Transformer achieves better BLEU scores',
    comments: [{ author: 'me', body: 'Not needed for the essay.', minutesAgo: 90 }],
    deletedMinutesAgo: 30,
  },
  {
    reading: 'Deep Residual Learning for Image Recognition',
    page: 5,
    quote: null,
    comments: [{ author: 'me', body: 'Old question about the 1x1 convolutions, answered in the lecture.', minutesAgo: 30 * 60 }],
    deletedMinutesAgo: 2 * DAY / MINUTE,
  },
];

/** Where the owner stopped in the readings that have a history: page index (from 0) and minutes read are fake.ts's. */
const STOPPED_AT: Readonly<Record<string, number>> = {
  'Attention Is All You Need': 5,
  'Difference-in-Differences with Multiple Time Periods': 21,
  'Deep Residual Learning for Image Recognition': 3,
  'Linear Algebra Done Right': 30,
  'Introduction to Algorithms, Lecture 1: Introduction': 4,
  'Lecture 2: Image Classification with Linear Classifiers': 41,
  'XGBoost: A Scalable Tree Boosting System': 0,
};

const claudeMeta = (question: CommentId): ClaudeReplyMeta => ({
  kind: 'claude-reply',
  v: 1,
  role: 'default',
  status: 'done',
  error: null,
  questionId: question,
  citations: [],
  webSources: [],
  usage: null,
  scope: 'passages',
  figureLabels: [],
  via: 'viewer',
});

function anchorOf(seed: NoteSeed): Anchor {
  if (seed.page === null) return { kind: 'document' };
  if (seed.quote === null) return { kind: 'page', page: seed.page };
  return {
    kind: 'text',
    quote: { quote: seed.quote, prefix: '', suffix: '' },
    start: { page: seed.page, index: 0 },
    end: { page: seed.page, index: seed.quote.length },
    rects: [],
  };
}

export interface FakePagesOptions {
  now: number;
  /** The fake library's readings, as they are now (a trashed reading's notes are not listed). */
  readings(this: void): LibraryItem[];
  /** Tells the pages that something changed. */
  changed(this: void): void;
}

export function createFakePagesData(o: FakePagesOptions): PagesData {
  const idOf = (title: string): DocumentId | null => o.readings().find((r) => r.doc.title === title)?.doc.id ?? null;
  const threads: { thread: ThreadRow; comments: CommentRow[] }[] = [];
  NOTES.forEach((seed, i) => {
    const documentId = idOf(seed.reading);
    if (documentId === null) return;
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` as ThreadId;
    const first = o.now - (seed.comments[0]?.minutesAgo ?? 0) * MINUTE;
    const deletedAt = seed.deletedMinutesAgo === undefined ? null : o.now - seed.deletedMinutesAgo * MINUTE;
    const thread: ThreadRow = {
      id,
      documentId,
      anchor: anchorOf(seed),
      pageIndex: seed.page,
      sortKey: null,
      placement: 'placed',
      draftOfTab: null,
      createdAt: first,
      updatedAt: first,
      rev: 0,
      hlc: '',
      deletedAt,
    };
    let root: CommentId | null = null;
    const comments = seed.comments.map((c, j): CommentRow => {
      const cid = `${id.slice(0, -2)}${String(j).padStart(2, '0')}c` as CommentId;
      root ??= cid;
      return {
        id: cid,
        threadId: id,
        documentId,
        author: c.author,
        body: c.body,
        draftOfTab: null,
        meta: c.author === 'claude' && root !== null ? claudeMeta(root) : {},
        createdAt: o.now - c.minutesAgo * MINUTE,
        editedAt: null,
        rev: 0,
        hlc: '',
        deletedAt: null,
      };
    });
    threads.push({ thread, comments });
  });

  const settings = new Map<string, unknown>([
    ['filter.allow', ['moodle.lse.ac.uk']],
    ['filter.deny', ['C:\\Users\\me\\Documents\\Bank']],
  ]);
  const checkList = (key: string, entry: unknown): void => {
    const list = key === 'filter.allow' ? 'allow' : key === 'filter.deny' ? 'deny' : null;
    if (list === null) return;
    const problem = listEntryProblem(entry, list);
    if (problem !== null) throw new Error(`bad-input: this can’t be on the ${list} list: ${problem}`);
  };

  const live = () => new Set(o.readings().filter((r) => r.doc.deletedAt === null).map((r) => r.doc.id));
  const titleOf = (id: DocumentId) => {
    const r = o.readings().find((x) => x.doc.id === id);
    return r === undefined ? 'Untitled PDF' : shownTitle(r.doc.title, r.location?.raw ?? null);
  };

  return {
    listNotes(q) {
      const shown = live();
      const rows = threads
        .filter((t) => shown.has(t.thread.documentId) && (q.trashed === true) === (t.thread.deletedAt !== null))
        .filter((t) => q.author === undefined || t.comments.some((c) => c.author === q.author))
        .map((t): NoteItem & { at: number } => ({
          thread: t.thread,
          comments: t.comments,
          title: titleOf(t.thread.documentId),
          at: q.trashed === true ? (t.thread.deletedAt ?? 0) : Math.max(...t.comments.map((c) => c.createdAt)),
        }))
        .sort((a, b) => b.at - a.at);
      const start = q.cursor === undefined ? 0 : Number(q.cursor);
      const page = rows.slice(start, start + q.limit).map((r): NoteItem => ({ thread: r.thread, comments: r.comments, title: r.title }));
      return Promise.resolve({ items: page, nextCursor: start + page.length < rows.length ? String(start + page.length) : null });
    },
    getReading(id) {
      const r = o.readings().find((x) => x.doc.id === id);
      if (r === undefined) return Promise.resolve(null);
      const page = r.doc.title === null ? undefined : STOPPED_AT[r.doc.title];
      const state: ReadingState = {
        lastPosition: page === undefined ? null : { page, offset: 0, zoom: 1 },
        readingMs: r.readingMs,
        pagesVisited: page === undefined ? [] : Array.from({ length: page + 1 }, (_, i) => i),
        openCount: 3,
      };
      return Promise.resolve(state);
    },
    restoreNote(thread) {
      const t = threads.find((x) => x.thread.id === thread.id);
      if (t !== undefined) t.thread = { ...t.thread, deletedAt: null, updatedAt: Date.now() };
      o.changed();
      return Promise.resolve();
    },
    readingSource(id) {
      const r = o.readings().find((x) => x.doc.id === id);
      return Promise.resolve(r === undefined ? null : { doc: r.doc, location: r.location });
    },
    getSetting: (key) => Promise.resolve(settings.get(key) ?? null),
    setSetting(key, value) {
      if (Array.isArray(value)) for (const e of value) checkList(key, e);
      settings.set(key, value);
      return Promise.resolve();
    },
    addToSettingList(key, entry) {
      try {
        checkList(key, entry);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      const now = settings.get(key);
      const list = Array.isArray(now) ? (now as string[]) : [];
      const next = list.includes(entry.trim()) ? list : [...list, entry.trim()];
      settings.set(key, next);
      return Promise.resolve(next);
    },
    async exportNotes(sink) {
      const byDoc = new Map<DocumentId, { thread: ThreadRow; comments: CommentRow[] }[]>();
      for (const t of threads) if (t.thread.deletedAt === null) byDoc.set(t.thread.documentId, [...(byDoc.get(t.thread.documentId) ?? []), t]);
      const files = [...byDoc].map(([id, ts]) => {
        const doc = o.readings().find((r) => r.doc.id === id)?.doc;
        const markdown = exportMarkdown(
          { id, title: doc?.title ?? null, authors: doc?.authors ?? [] },
          [],
          ts.map((t) => t.thread),
          ts.flatMap((t) => t.comments),
        );
        return { path: notesPath(doc?.title, id), markdown };
      });
      await zipNotes(files, o.now).pipeTo(sink);
      return files.length;
    },
  };
}
