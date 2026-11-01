// Spec-blind tests for store schema v2 (slice S2): the upgrade from a filled v1 database.
//
// Sources:
//   plan Phase 2, S2: "a v1 database upgrades with nothing lost"; "v1 to v2 on a filled database, run twice; drafts never
//     reach the outbox or comments_fts; unknown JSON fields are kept; a higher user_version opens read-only".
//   plan Phase 2, done-when 10: "A filled v1 database upgrades to schema v2 with nothing lost."
//   contracts section 4: SCHEMA_V2 is additive only, "one transaction, then user_version = 2"; triggers re-created; one
//     comments_fts rebuild; "Each step is idempotent and tested from a filled v1 database"; "v1 data stays readable: anchors
//     without the new fields mean what they meant in v1"; "Code that finds user_version higher than it knows opens read-only
//     ... It never writes."
//   contracts section 3: drafts never reach the outbox; comments_fts holds non-draft, non-deleted rows only.
// Interface: migrate(db): number (Task 28), createStoreApi (Task 28), the Phase 2 StoreApi methods (contracts section 3).
// Starting point: a hand-built v1 database (v1-fixture.spec-blind.ts), never the code under test.
import { describe, expect, it } from 'vitest';
import { all, columnNames, count, dump, ftsHits, openMemoryDb, outboxRows, schemaText, tableNames, triggerNames, userVersion, value } from './db.spec-blind';
import { wrapStore } from './env.spec-blind';
import { migrate } from './migrate';
import { DOC, T_A, commentRow, markRow, textAnchor, threadRow } from './rows.spec-blind';
import { CLAUDE_META, V1_ANCHORS, V1_LIVE, V1_TABLES, fillV1 } from './v1-data.spec-blind';

const filledV1 = async () => {
  const db = await openMemoryDb();
  fillV1(db);
  return db;
};

/** Every v1 column of every v1 table, so a before/after comparison ignores only the columns v2 adds. */
const snapshot = (db: Awaited<ReturnType<typeof openMemoryDb>>) => Object.fromEntries(V1_TABLES.map((t) => [t, { cols: columnNames(db, t), rows: dump(db, t) }]));
const sameAfter = (db: Awaited<ReturnType<typeof openMemoryDb>>, before: ReturnType<typeof snapshot>) =>
  Object.fromEntries(Object.entries(before).map(([t, b]) => [t, { cols: b.cols, rows: dump(db, t, b.cols) }]));

describe('upgrade from a filled v1 database', () => {
  it('lands on user_version 2, and every v1 row in every v1 table is unchanged', async () => {
    const db = await filledV1();
    expect(userVersion(db)).toBe(1);
    const before = snapshot(db);
    expect(before['comments'].rows).toHaveLength(6); // the dataset is really filled: notes, a Claude reply, a draft, a tombstone

    expect(migrate(db as never)).toBe(3);

    expect(userVersion(db)).toBe(3);
    expect(sameAfter(db, before)).toEqual(before);
    // the new columns hold their documented defaults on old rows
    expect(all(db, 'SELECT DISTINCT author FROM marks').map((r) => r.author)).toEqual(['me']);
    expect(all(db, 'SELECT DISTINCT draft_of_tab FROM threads').map((r) => r.draft_of_tab)).toEqual([null]);
    expect(tableNames(db)).toEqual(expect.arrayContaining(['marks', 'threads', 'comments', 'comments_fts', 'page_figures']));
  });

  it('does not queue anything for sync by itself: the outbox is exactly what v1 left', async () => {
    const db = await filledV1();
    const queued = outboxRows(db);
    expect(queued.length).toBeGreaterThan(10);
    migrate(db);
    expect(outboxRows(db)).toEqual(queued);
  });

  it('is idempotent: migrating again, and migrating a database whose version was reset to 1, change nothing and lose nothing', async () => {
    const db = await filledV1();
    migrate(db);
    const schema = schemaText(db);
    const rows = Object.fromEntries(V1_TABLES.map((t) => [t, dump(db, t)]));

    expect(migrate(db as never)).toBe(3);
    expect(schemaText(db)).toBe(schema);

    // "run twice": the steps themselves must survive being run again (a restored backup, a downgrade tool, a retry)
    db.exec('PRAGMA user_version = 1');
    expect(() => migrate(db as never)).not.toThrow();
    expect(userVersion(db)).toBe(3);
    expect(Object.fromEntries(V1_TABLES.map((t) => [t, dump(db, t)]))).toEqual(rows);
    expect(schemaText(db)).toBe(schema);
  });

  it('keeps every v1 note readable through the store: anchors mean what they meant, tombstones stay hidden, drafts stay drafts', async () => {
    const db = await filledV1();
    migrate(db);
    const { api } = wrapStore(db);

    const a = await api.listAnnotations(DOC);
    expect(a.marks.map((m) => m.id).sort()).toEqual(V1_LIVE.marks);
    expect(a.threads.map((t) => t.id).sort()).toEqual(V1_LIVE.threads);
    expect(a.comments.map((c) => c.id).sort()).toEqual(V1_LIVE.comments);

    const m1 = a.marks.find((m) => m.id === 'm1')!;
    expect(m1).toMatchObject({ documentId: DOC, style: 'highlight', color: 2, pageIndex: 0, sortKey: 0.2, author: 'me', deletedAt: null, rev: 3 });
    expect(m1.anchor).toEqual(V1_ANCHORS.textA);
    expect(a.marks.find((m) => m.id === 'm2')!.anchor).toEqual(V1_ANCHORS.textB); // a note across two pages
    expect(a.marks.find((m) => m.id === 'm3')).toMatchObject({ style: 'area', color: null });
    expect(a.threads.find((t) => t.id === 't3')).toMatchObject({ pageIndex: null, sortKey: null, draftOfTab: null, placement: 'placed' });

    const claude = a.comments.find((c) => c.id === 'c3')!;
    expect(claude).toMatchObject({ author: 'claude', threadId: 't1' });
    expect(claude.meta).toEqual(CLAUDE_META); // unknown JSON fields are kept
    expect(a.comments.filter((c) => c.threadId === ('t1' as never)).map((c) => c.id)).toEqual(['c1', 'c2', 'c3']); // in the order they were written

    // the v1 draft is still there for the tab that owned it, and for nobody else
    expect((await api.listDrafts(DOC, 'old-tab-1' as never)).map((c) => [c.id, c.body])).toEqual([['c5', 'unsent thought about quokkas']]);
    expect(await api.listDrafts(DOC, T_A)).toEqual([]);
    const adopted = await api.claimDrafts(DOC, T_A, []);
    expect(adopted.map((c) => [c.id, c.draftOfTab])).toEqual([['c5', T_A]]);
  });

  it('rebuilds comments_fts once: live notes are found, deleted and draft ones are not, and the index is sound', async () => {
    const db = await filledV1();
    // v1 left the deleted note searchable (its trigger indexes every non-draft row): the rebuild must fix that
    expect(ftsHits(db, 'okapi')).toEqual(['c6']);
    migrate(db);

    expect(ftsHits(db, 'placebo')).toEqual(['c2']);
    expect(ftsHits(db, 'plausible')).toEqual(['c1']);
    expect(ftsHits(db, 'pre')).toEqual(['c3']); // the Claude reply is searchable too
    expect(ftsHits(db, 'zebra')).toEqual(['c4']);
    expect(ftsHits(db, 'okapi')).toEqual([]); // soft-deleted
    expect(ftsHits(db, 'quokkas')).toEqual([]); // draft
    expect(() => db.exec("INSERT INTO comments_fts(comments_fts) VALUES('integrity-check')")).not.toThrow();
    expect(count(db, 'comments_fts')).toBe(4);
  });

  it('replaces the v1 triggers instead of adding to them: drafts reach neither the outbox nor the index afterwards', async () => {
    const fresh = await openMemoryDb();
    migrate(fresh);
    const db = await filledV1();
    migrate(db);
    // Only the triggers v2 owns are compared by name: the fixture's v1 trigger names are a guess, and v2 finds v1's triggers by
    // what they do. The v1 triggers v2 does not touch (documents, marks, ...) keep whatever names the v1 database gave them.
    for (const table of ['threads', 'comments']) expect(triggerNames(db, table), `${table}: no leftovers of v1`).toEqual(triggerNames(fresh, table));
    expect(triggerNames(db).length, 'the same number of triggers as a new database').toBe(triggerNames(fresh).length);

    const queued = outboxRows(db).length;
    // a new thread whose first comment is unsent: neither row syncs (contracts section 4: threads outbox triggers skip drafts)
    db.exec({ sql: "INSERT INTO threads(id, document_id, anchor, page_index, sort_key, draft_of_tab, created_at, updated_at, hlc) VALUES ('t9', ?, '{\"kind\":\"document\"}', NULL, NULL, 'tab-x', 1, 1, 'h')", bind: [DOC] });
    db.exec({ sql: "INSERT INTO comments(id, thread_id, document_id, author, body, draft_of_tab, meta, created_at, hlc) VALUES ('c9', 't9', ?, 'me', 'secret walrus draft', 'tab-x', '{}', 1, 'h')", bind: [DOC] });
    db.exec("UPDATE comments SET body = 'secret walrus draft, longer' WHERE id = 'c9'");
    db.exec("UPDATE threads SET updated_at = 2 WHERE id = 't9'");
    expect(outboxRows(db).length, 'typing a draft queued something for sync').toBe(queued);
    expect(ftsHits(db, 'walrus'), 'a draft was indexed').toEqual([]);

    // sending: both rows now sync, and the text becomes searchable (the UPDATE triggers handle draft -> sent)
    db.exec("UPDATE comments SET draft_of_tab = NULL WHERE id = 'c9'");
    db.exec("UPDATE threads SET draft_of_tab = NULL WHERE id = 't9'");
    expect(outboxRows(db).slice(queued).map((r) => [r.table, r.id, r.op])).toEqual(expect.arrayContaining([['comments', 'c9', 'upsert'], ['threads', 't9', 'upsert']]));
    expect(ftsHits(db, 'walrus')).toEqual(['c9']);

    // discarding a draft thread (a hard delete of an unsent draft) must not enqueue a delete for something never pushed
    db.exec({ sql: "INSERT INTO threads(id, document_id, anchor, draft_of_tab, created_at, updated_at, hlc) VALUES ('t8', ?, '{\"kind\":\"document\"}', 'tab-x', 1, 1, 'h')", bind: [DOC] });
    const before = outboxRows(db).length;
    db.exec("DELETE FROM threads WHERE id = 't8'");
    expect(outboxRows(db).length).toBe(before);
  });
});

describe('an upgrade that cannot finish', () => {
  // The contract says one transaction. Whatever goes wrong, the database is either wholly v2 or wholly v1.
  const sabotage: { name: string; run: (db: Awaited<ReturnType<typeof openMemoryDb>>) => void; mustFail: boolean }[] = [
    { name: 'a table already uses the name of the new index', run: (db) => db.exec('CREATE TABLE comments_drafts (x)'), mustFail: true },
    { name: 'comments_fts is missing', run: (db) => db.exec('DROP TABLE comments_fts'), mustFail: false },
  ];
  it.each(sabotage)('$name: all or nothing', async ({ run, mustFail }) => {
    const db = await filledV1();
    run(db);
    const schema = schemaText(db);
    const before = snapshot(db);

    let failed = false;
    try {
      migrate(db);
    } catch {
      failed = true;
    }
    if (mustFail) expect(failed, 'the clash should have stopped the upgrade').toBe(true);

    if (userVersion(db) === 1) {
      expect(schemaText(db), 'a half-done upgrade left changes behind').toBe(schema);
      expect(sameAfter(db, before)).toEqual(before);
    } else {
      expect(failed).toBe(false);
      expect(userVersion(db)).toBe(3);
      expect(columnNames(db, 'marks')).toContain('author');
      expect(columnNames(db, 'threads')).toContain('draft_of_tab');
      expect(sameAfter(db, before)).toEqual(before);
    }
  });
});

describe('a database from a newer version', () => {
  it('is left alone: the version, the schema and every row stay as they were, whatever the store is asked to write', async () => {
    const db = await filledV1();
    db.exec('PRAGMA user_version = 99');
    const schema = schemaText(db);
    const before = snapshot(db);

    try {
      migrate(db); // may return 99 or refuse; it must not change anything
    } catch {
      /* refusing is allowed */
    }
    expect(userVersion(db)).toBe(99);

    const attempts: (() => Promise<unknown>)[] = [];
    try {
      const { api } = wrapStore(db);
      attempts.push(
        () => api.writeAnnotations([{ table: 'marks', op: 'upsert', row: markRow({ id: 'new-mark' }) }]),
        () => api.writeAnnotations([{ table: 'threads', op: 'soft-delete', row: threadRow({ id: 't1' }) }]),
        () => api.saveDraft(commentRow({ id: 'new-draft', threadId: 't1', draftOfTab: T_A }) as never),
        () => api.sendDraft('c5' as never),
        () => api.claimDrafts(DOC, T_A, []),
        () => api.putPageFigures(DOC, 3, '1', []),
      );
    } catch {
      /* refusing to open is allowed too */
    }
    for (const attempt of attempts) await attempt().catch(() => undefined);

    expect(userVersion(db)).toBe(99);
    expect(schemaText(db)).toBe(schema);
    expect(sameAfter(db, before)).toEqual(before);
  });
});

describe('a new database', () => {
  it('lands on v2 with the contracted columns, the draft index and the author constraint', async () => {
    const db = await openMemoryDb();
    expect(migrate(db as never)).toBe(3);
    expect(migrate(db as never)).toBe(3);
    expect(columnNames(db, 'marks')).toContain('author');
    expect(columnNames(db, 'threads')).toContain('draft_of_tab');
    expect(all(db, "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'comments'").map((r) => r.name)).toContain('comments_drafts');

    db.exec({ sql: "INSERT INTO documents(id, page_count, byte_size, has_text, created_at, updated_at, hlc) VALUES (?, 1, 1, 1, 1, 1, 'h')", bind: [DOC] });
    const insertMark = (author: string) =>
      db.exec({ sql: `INSERT INTO marks(id, document_id, style, color, anchor, page_index, sort_key, author, created_at, updated_at, hlc) VALUES ('mk-' || ?, ?, 'highlight', 1, ?, 0, 0.1, ?, 1, 1, 'h')`, bind: [author, DOC, JSON.stringify(textAnchor(0, 1, 2)), author] });
    expect(() => insertMark('me')).not.toThrow();
    expect(() => insertMark('claude')).not.toThrow();
    expect(() => insertMark('robot')).toThrow(/CHECK/);
    expect(value(db, "SELECT author FROM marks WHERE id = 'mk-me'")).toBe('me');
  });
});
