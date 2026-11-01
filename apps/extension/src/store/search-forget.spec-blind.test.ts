// Spec-blind tests for Task 28: page search (searchPages) and Forget (forgetDocument), the document side.
//
// Sources:
//   spec, "One search box (Ctrl+K)": covers "titles, authors, full page text ... ranked by relevance with highlighted snippets".
//   interface file (Task 28): searchPages(query, limit) -> PageHit { documentId, pageIndex, snippet, rank }; the normative schema
//     page_text_fts (unicode61, remove_diacritics 2); putPageText replaces a page (UNIQUE (document_id, page_index)).
//   spec, Privacy: "'Forget this PDF' removes it completely"; ruling R13 (interface file): forgetDocument "deletes the document and every
//     row that hangs off it, deletes every outbox row for it, and runs FTS5 'optimize' on comments_fts, documents_fts and page_text_fts,
//     so no deleted words stay in the index files"; a forgotten PDF "leaves no bytes behind".
//   spec, Sync: Forget removes it "including from your cloud", so nothing about it may be left in the outbox.
//   CLAUDE.md non-negotiables: no lost notes (Forget of one PDF must not hurt another), nothing saved from non-learning PDFs.
// Real store over real SQLite (in memory). The probes read the database's own tables, the search indexes' shadow tables included, because
// an FTS5 index keeps deleted words in its segments until they are merged away.
import { describe, expect, it, vi } from 'vitest';
import type { CommentRow, DocumentId, MarkRow, ThreadRow } from '../../../../packages/core/src/index';
import { count, outboxRows, rowsMentioning } from './db.spec-blind';
import { freshStore, quiet, type StoreEnv } from './env.spec-blind';
import { ALIAS_1, ALIAS_2, asPages, assertIndexesSound, bodyOf } from './library.spec-blind';
import { DOC, DOC2, SAMPLE_INPUT, commentRow, markRow, threadRow } from './rows.spec-blind';

vi.setConfig({ testTimeout: 30_000 }); // each test builds a whole database in WebAssembly; a busy machine needs more than 5 s

type Op = Parameters<StoreEnv['api']['writeAnnotations']>[0][number];
const up = (table: Op['table'], row: MarkRow | ThreadRow | CommentRow): Op => ({ table, op: 'upsert', row });

describe('searching the pages', () => {
  const PAGES = [
    'Introduction. We use the difference-in-differences design and test parallel trends before the policy change.',
    'Placebo outcomes: the naïve estimator and a café survey. The placebo test finds no anticipation.',
    `${bodyOf(3, 2, 200)} kangaroo ${bodyOf(3, 3, 200)}`,
    'kangaroo kangaroo kangaroo hop',
  ];

  async function library(): Promise<StoreEnv> {
    const env = await freshStore();
    await env.api.saveDocument({ ...SAMPLE_INPUT, id: DOC2, title: 'Island tourism', location: null });
    await env.api.putPageText(DOC, asPages(PAGES));
    await env.api.putPageText(DOC2, asPages(['A study of Kangaroo island tourism.']));
    return env;
  }

  it('finds the page, with its document, its page number and a snippet that shows the word', async () => {
    const env = await library();
    const hits = await env.api.searchPages('placebo', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ documentId: DOC, pageIndex: 1 });
    expect(hits[0].snippet).toMatch(/placebo/i);
    expect(typeof hits[0].rank).toBe('number');
  });

  it('puts the page that is most about the word first, never lists a page twice, and honours the limit', async () => {
    const env = await library();
    const all = await env.api.searchPages('kangaroo', 10);
    expect(all.map((h) => [h.documentId, h.pageIndex])).toHaveLength(3);
    expect(new Set(all.map((h) => `${h.documentId}:${h.pageIndex}`)).size).toBe(3);
    expect(all[0]).toMatchObject({ documentId: DOC, pageIndex: 3 });

    expect(await env.api.searchPages('kangaroo', 2)).toEqual(all.slice(0, 2));
    expect(await env.api.searchPages('kangaroo', 1)).toEqual(all.slice(0, 1));
  });

  it.each([
    { typed: 'NAIVE', page: 1 },
    { typed: 'cafe', page: 1 },
    { typed: 'CAFÉ', page: 1 },
    { typed: 'difference-in-differences', page: 0 },
    { typed: 'parallel trends', page: 0 },
    { typed: '"parallel trends"', page: 0 },
    { typed: 'trends,', page: 0 },
  ])('finds "$typed" on page $page, as typed (case, accents, hyphens and punctuation do not matter)', async ({ typed, page }) => {
    const env = await library();
    const hits = await env.api.searchPages(typed, 10);
    expect(hits.map((h) => [h.documentId, h.pageIndex])).toContainEqual([DOC, page]);
  });

  it('a page that is read again replaces its old text: the old words are gone from search, the new ones are found', async () => {
    const env = await library();
    await env.api.putPageText(DOC, [{ pageIndex: 1, text: 'Second reading: wholly different vocabulary about axolotls.' }]);

    expect(await env.api.searchPages('placebo', 10)).toEqual([]);
    expect((await env.api.searchPages('axolotls', 10)).map((h) => [h.documentId, h.pageIndex])).toEqual([[DOC, 1]]);
    expect(await env.api.stats()).toMatchObject({ pageText: 5 });
    assertIndexesSound(env.db);
  });

  const TYPED_BY_A_PERSON = ['"unclosed', 'AND', 'OR parallel', 'foo OR', 'NEAR(', '(parallel', 'c++', 'a:b', '*', '-trends', "it's", 'trends)', '^', '\\', "'; DROP TABLE documents; --", '', '   '];
  it.each(TYPED_BY_A_PERSON.map((q) => ({ q })))('whatever is typed in the search box, $q, is an answer and never an error', async ({ q }) => {
    const env = await library();
    const hits = await env.api.searchPages(q, 10);
    expect(Array.isArray(hits)).toBe(true);
    if (q.trim() === '') expect(hits).toEqual([]);
    expect(await env.api.stats(), 'the library is still there').toMatchObject({ documents: 2 });
  });
});

describe('Forget this PDF', () => {
  const GONE = {
    title: 'The Quokkanomics handbook',
    author: 'Ximena Zibbleton',
    pages: ['Chapter one about the platypusword economy.', 'Chapter two: the echidnaword effect, with no marsupials.'],
    url: 'https://quokka-links.example/papers/q.pdf',
    file: 'file:///C:/Users/Rex/quokka-notes/q.pdf',
  };
  const STAYS = { title: 'Marmoset ecology', author: 'Bartholomew Tamarin', pages: ['Gibbonword habitat survey of the canopy.'], url: 'https://marmoset.example/m.pdf' };

  /** Two papers in the library, each with an alias, places, page text, reading history and notes. Returns the ids that belong to DOC. */
  async function twoPapers(env: StoreEnv) {
    await env.api.saveDocument({ ...SAMPLE_INPUT, title: GONE.title, authors: [GONE.author], location: { kind: 'url', raw: GONE.url, viaPage: null } });
    await env.api.touchLocation({ documentId: DOC, kind: 'file', raw: GONE.file, viaPage: null, at: env.clock.t });
    await env.api.saveDocument({ ...SAMPLE_INPUT, id: DOC2, title: STAYS.title, authors: [STAYS.author], location: { kind: 'url', raw: STAYS.url, viaPage: null } });
    await env.api.addAlias(ALIAS_1, DOC, 0.999);
    await env.api.addAlias(ALIAS_2, DOC2, 0.999);
    await env.api.putPageText(DOC, asPages(GONE.pages));
    await env.api.putPageText(DOC2, asPages(STAYS.pages));
    await env.api.recordOpen(DOC, env.clock.t + 1000);
    await env.api.recordOpen(DOC2, env.clock.t + 1000);
    await env.api.writeAnnotations([
      up('threads', threadRow({ id: 'thread-gone' })),
      up('comments', commentRow({ id: 'comment-gone', threadId: 'thread-gone', body: 'my wombatword note' })),
      up('marks', markRow({ id: 'mark-gone' })),
      up('threads', threadRow({ id: 'thread-stays', documentId: DOC2 })),
      up('comments', commentRow({ id: 'comment-stays', threadId: 'thread-stays', documentId: DOC2, body: 'a note on the other paper' })),
    ]);
    const places = (await env.api.listLocations(DOC)).map((l) => l.id);
    expect(places, 'two places were recorded').toHaveLength(2);
    return { ids: [DOC as string, ALIAS_1, ...places, 'thread-gone', 'comment-gone', 'mark-gone'] };
  }

  const WORDS_GONE = ['quokkanomics', 'Quokkanomics', 'Zibbleton', 'zibbleton', 'Ximena', 'ximena', 'platypusword', 'echidnaword', 'wombatword', 'quokka-links.example', 'quokka-notes'];

  it('leaves no row, no queued change, no id and no word of the PDF behind, and leaves the other PDF exactly as it was', async () => {
    const env = await freshStore({ document: false });
    const { ids } = await twoPapers(env);
    const queuedFor = (wanted: readonly string[]) => outboxRows(env.db).filter((r) => wanted.includes(r.id));
    expect(queuedFor(ids).length, 'the probe sees queued changes for the PDF before Forget').toBeGreaterThan(0);
    for (const needle of [...ids, ...WORDS_GONE]) expect(rowsMentioning(env.db, needle).length, `the probe finds "${needle}" before Forget`).toBeGreaterThan(0);
    const otherOutbox = outboxRows(env.db).filter((r) => r.id === DOC2 || r.id === ALIAS_2 || r.id === 'comment-stays' || r.id === 'thread-stays');
    expect(otherOutbox.length).toBeGreaterThan(0);
    env.publish.mockClear();

    await env.api.forgetDocument(DOC);

    expect(await env.api.getDocument(DOC)).toBeNull();
    expect(await env.api.resolveFingerprint(DOC)).toBeNull();
    expect(await env.api.resolveFingerprint(ALIAS_1), 'the alias goes with the document').toBeNull();
    expect(await env.api.listLocations(DOC)).toEqual([]);
    expect(await env.api.listAnnotations(DOC)).toEqual({ marks: [], threads: [], comments: [] });
    expect(await env.api.searchPages('platypusword', 10)).toEqual([]);
    expect(queuedFor(ids), 'nothing about a forgotten PDF may stay queued to sync').toEqual([]);
    for (const needle of [...ids, ...WORDS_GONE]) expect(rowsMentioning(env.db, needle), `a trace of "${needle}" is left`).toEqual([]);
    expect(env.changes()).toContainEqual(expect.objectContaining({ table: 'documents', op: 'delete', ids: [DOC] }));
    assertIndexesSound(env.db);
    expect(env.db.selectValue('PRAGMA foreign_key_check')).toBeUndefined();

    // The other paper is untouched, notes and queued changes included.
    expect(await env.api.getDocument(DOC2)).toMatchObject({ id: DOC2, title: STAYS.title, authors: [STAYS.author] });
    expect(await env.api.resolveFingerprint(ALIAS_2)).toBe(DOC2);
    expect(await env.api.listLocations(DOC2)).toHaveLength(1);
    expect((await env.api.listAnnotations(DOC2)).comments.map((c) => c.id)).toEqual(['comment-stays']);
    expect((await env.api.searchPages('gibbonword', 10)).map((h) => h.documentId)).toEqual([DOC2]);
    expect(await env.api.stats()).toMatchObject({ documents: 1, aliases: 1, locations: 1, pageText: 1, history: 1 });
    expect(outboxRows(env.db).filter((r) => r.id === DOC2 || r.id === ALIAS_2 || r.id === 'comment-stays' || r.id === 'thread-stays')).toEqual(otherOutbox);
  });

  it('removes the words from the search indexes\' own storage too (R13: FTS5 keeps deleted words until the segments are merged)', async () => {
    const env = await freshStore({ document: false });
    await twoPapers(env);
    const inIndex = (needle: string) => rowsMentioning(env.db, needle).map(([table]) => table).filter((table) => /_fts_(data|content|docsize|idx)$/.test(table));
    // control: before Forget the words really are in the indexes' storage, so the probe can see them
    expect(inIndex('platypusword')).toContain('page_text_fts_data');
    expect(inIndex('zibbleton')).toContain('documents_fts_data');
    expect(inIndex('wombatword')).toContain('comments_fts_data');

    await env.api.forgetDocument(DOC);

    for (const word of ['platypusword', 'echidnaword', 'zibbleton', 'quokkanomics', 'ximena', 'wombatword']) {
      expect(inIndex(word), `"${word}" is still in the index files`).toEqual([]);
      expect(rowsMentioning(env.db, word), `"${word}" is still somewhere in the database`).toEqual([]);
    }
    expect(inIndex('gibbonword'), 'the other paper stays searchable').toContain('page_text_fts_data');
    expect(inIndex('tamarin')).toContain('documents_fts_data');
  });

  it('forgetting twice, or forgetting a PDF that was never saved, is harmless', async () => {
    const env = await freshStore({ document: false });
    await twoPapers(env);
    await env.api.forgetDocument(DOC);
    await expect(env.api.forgetDocument(DOC)).resolves.toBeUndefined();
    await expect(env.api.forgetDocument('ef'.repeat(32) as DocumentId)).resolves.toBeUndefined();
    expect(await env.api.stats()).toMatchObject({ documents: 1 });
    expect(await env.api.getDocument(DOC2)).not.toBeNull();
    assertIndexesSound(env.db);
  });

  it('leaves the library usable: the same PDF can be saved again as a brand new document, with none of the old notes', async () => {
    const env = await freshStore({ document: false });
    await twoPapers(env);
    await env.api.forgetDocument(DOC);
    quiet(env);

    const again = await env.api.saveDocument({ ...SAMPLE_INPUT, title: 'Back again', location: null });

    expect(again.created).toBe(true);
    expect(await env.api.listAnnotations(DOC)).toEqual({ marks: [], threads: [], comments: [] });
    expect(await env.api.searchPages('platypusword', 10)).toEqual([]);
    expect(count(env.db, 'documents_fts', `document_id = '${DOC}'`)).toBe(1);
  });
});
