// Spec-blind tests for Task 28, the library side of the store: saving a document, its places (locations), the queue for sync,
// the change announcements, and "an unsaved PDF leaves no trace".
//
// Sources:
//   spec, Identity rules 1, 4, 5: a document is its fingerprint; "Links are canonical ... Session keys such as Moodle's sesskey are
//     always removed: they ... must not be stored or synced"; "A location's id is a hash of its canonical link".
//   spec, walkthrough 9: "Same contents, same fingerprint, same notes ... The library records the new location."
//   spec, Local traces: "A PDF that isn't saved leaves no history row, thumbnail, search entry or log line."
//   spec, Storage: SQLite with an outbox of changes to sync; "a broadcast channel tells every open tab when something changes".
//   interface file (Task 28): saveDocument "documents + history + location, one transaction, idempotent"; the normative schema
//     (foreign keys ON; page_text, search indexes and caches never sync; synced tables are queued by triggers); migrate returns 2
//     and sets foreign_keys=ON, synchronous=FULL, secure_delete=ON (ruling R13).
//   CLAUDE.md non-negotiables: "no lost notes", "nothing saved from non-learning PDFs".
// Real store over real SQLite (in memory). The database is also read directly where the rule is about what is on disk.
import { describe, expect, it, vi } from 'vitest';
import { canonicalLocation, locationId } from '../../../../packages/core/src/index';
import type { CommentRow, LocationKind, MarkRow, ThreadRow } from '../../../../packages/core/src/index';
import { count, openMemoryDb, outboxRows, rowsMentioning, value } from './db.spec-blind';
import { freshStore, type StoreEnv } from './env.spec-blind';
import { ALIAS_1, GHOST, ZERO_STATS, assertIndexesSound } from './library.spec-blind';
import { migrate } from './migrate';
import { DOC, SAMPLE_INPUT, commentRow, markRow, threadRow } from './rows.spec-blind';

type Op = Parameters<StoreEnv['api']['writeAnnotations']>[0][number];
const up = (table: Op['table'], row: MarkRow | ThreadRow | CommentRow): Op => ({ table, op: 'upsert', row });
const T0 = 1_700_000_000_000;
vi.setConfig({ testTimeout: 30_000 }); // each test builds a whole database in WebAssembly; a busy machine needs more than 5 s

describe('saving a document', () => {
  it('is idempotent: saving the same PDF again changes nothing, and never touches the notes, alias, page text or history it already has', async () => {
    const env = await freshStore({ document: false });
    const first = await env.api.saveDocument(SAMPLE_INPUT);
    expect(first.created).toBe(true);
    expect(first.row).toMatchObject({
      id: DOC, pageCount: 8, byteSize: 123_456, title: SAMPLE_INPUT.title, authors: ['A. Author'], hasText: true, encrypted: false,
      blobStored: false, saveReasons: ['spec-blind test'], deletedAt: null,
    });
    expect(await env.api.getDocument(DOC)).toEqual(first.row);
    expect(await env.api.stats()).toMatchObject({ documents: 1, locations: 1, history: 1 });

    // The owner has been reading: an alias, page text, a note with a highlight, and reading history all hang off the document.
    await env.api.addAlias(ALIAS_1, DOC, 0.999);
    await env.api.putPageText(DOC, [{ pageIndex: 0, text: 'kangaroo rats hop' }, { pageIndex: 1, text: 'a second page' }]);
    await env.api.writeAnnotations([up('threads', threadRow({ id: 'thread-keep' })), up('comments', commentRow({ id: 'comment-keep', threadId: 'thread-keep', body: 'a note that must survive' })), up('marks', markRow({ id: 'mark-keep' }))]);
    await env.api.recordOpen(DOC, T0 + 1000);
    const notes = await env.api.listAnnotations(DOC);
    expect(notes.threads).toHaveLength(1);

    // Opening the same PDF again saves it again (a different link, a later time).
    env.clock.t += 5 * 60_000;
    const again = await env.api.saveDocument({ ...SAMPLE_INPUT, openedAt: env.clock.t });

    expect(again.created).toBe(false);
    expect(again.row.id).toBe(DOC);
    expect(again.row.createdAt).toBe(first.row.createdAt);
    expect(await env.api.listAnnotations(DOC)).toEqual(notes);
    expect(await env.api.resolveFingerprint(ALIAS_1)).toBe(DOC);
    expect(await env.api.searchPages('kangaroo', 5)).toHaveLength(1);
    expect(await env.api.stats()).toMatchObject({ documents: 1, aliases: 1, locations: 1, pageText: 2, history: 1 });
    expect(count(env.db, 'documents_fts'), 'the title is in the search index once, not twice').toBe(1);
    assertIndexesSound(env.db);
  });

  it.each([{ table: 'history' }, { table: 'locations' }])(
    'is all or nothing: a failure while writing the $table row leaves no document, no index entry, no queued change and no announcement, and a retry saves cleanly',
    async ({ table }) => {
      const env = await freshStore({ document: false });
      env.db.exec(`CREATE TRIGGER sabotage BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'disk full'); END`);

      await expect(env.api.saveDocument(SAMPLE_INPUT)).rejects.toBeDefined();

      expect(await env.api.stats()).toEqual(ZERO_STATS);
      expect(await env.api.getDocument(DOC)).toBeNull();
      expect(count(env.db, 'documents_fts')).toBe(0);
      expect(rowsMentioning(env.db, DOC)).toEqual([]);
      expect(env.changes(), 'nothing is announced for something that was not stored').toEqual([]);

      env.db.exec('DROP TRIGGER sabotage');
      const retry = await env.api.saveDocument(SAMPLE_INPUT);
      expect(retry.created, 'the failed attempt left no half-made document behind').toBe(true);
      expect(await env.api.stats()).toMatchObject({ documents: 1, locations: 1, history: 1 });
    },
  );
});

describe('where a PDF was seen (locations)', () => {
  const SESSKEY = 'Zk3d9aQwLm';
  const CASES: { name: string; kind: LocationKind; raws: string[]; places: number }[] = [
    {
      name: 'the same link with tracking noise, http, a page fragment and a Moodle session key is one place, and the key is stored nowhere',
      kind: 'url',
      raws: ['https://example.org/paper.pdf', `http://example.org/paper.pdf?utm_source=newsletter&sesskey=${SESSKEY}#page=3`],
      places: 1,
    },
    {
      name: 'a session key on the very first link the PDF is saved with is not stored either',
      kind: 'url',
      raws: [`https://moodle.example.edu/pluginfile.php/1/mod_resource/content/0/w.pdf?forcedownload=1&sesskey=${SESSKEY}`, 'https://moodle.example.edu/pluginfile.php/1/mod_resource/content/0/w.pdf'],
      places: 1,
    },
    { name: 'two real addresses are two places', kind: 'url', raws: ['https://example.org/paper.pdf', 'https://mirror.example.net/papers/paper.pdf'], places: 2 },
    {
      name: 'a file spelt two ways (encoded spaces and a drive letter in either case, "localhost" or no host) is one place',
      kind: 'file',
      raws: ['file:///C:/Users/Rex/My%20Papers/a%20paper.pdf', 'file://localhost/c:/Users/Rex/My Papers/a paper.pdf'],
      places: 1,
    },
  ];

  it.each(CASES)('$name', async ({ kind, raws, places }) => {
    const env = await freshStore({ document: false });
    await env.api.saveDocument({ ...SAMPLE_INPUT, location: { kind, raw: raws[0], viaPage: null }, openedAt: T0 });
    const touched = [];
    for (const [i, raw] of raws.slice(1).entries()) {
      const at = T0 + (i + 1) * 60_000;
      env.clock.t = at;
      touched.push(await env.api.touchLocation({ documentId: DOC, kind, raw, viaPage: null, at }));
    }

    const expected = [...new Set(raws.map((raw) => canonicalLocation(kind, raw)))].sort();
    expect(expected, 'the canonical-link rules say how many places these are').toHaveLength(places);
    const stored = await env.api.listLocations(DOC);
    expect(stored.map((l) => l.canonical).sort()).toEqual(expected);
    for (const place of stored) {
      expect(place).toMatchObject({ documentId: DOC, kind });
      expect(place.id, 'the id is the hash of kind and canonical link').toBe(await locationId(kind, place.canonical));
    }
    for (const row of touched) expect(stored.find((l) => l.id === row.id), 'touchLocation answers with the stored row').toEqual(row);
    if (expected.length === 1) {
      expect(stored[0]).toMatchObject({ firstSeen: T0, lastSeen: T0 + 60_000 });
    } else {
      expect(stored.find((l) => l.canonical === canonicalLocation(kind, raws[1]))).toMatchObject({ firstSeen: T0 + 60_000, lastSeen: T0 + 60_000 });
    }
    expect(rowsMentioning(env.db, SESSKEY), 'a session key must not be stored (spec, Identity rule 4)').toEqual([]);
  });

  it('keeps the page that led to the file (the Moodle page), and lists the places of one document only', async () => {
    const env = await freshStore({ document: false });
    const via = 'https://moodle.example.edu/mod/resource/view.php?id=77';
    await env.api.saveDocument({ ...SAMPLE_INPUT, location: { kind: 'url', raw: 'https://moodle.example.edu/pluginfile.php/1/mod_resource/content/0/week1.pdf', viaPage: via }, openedAt: T0 });
    await env.api.saveDocument({ ...SAMPLE_INPUT, id: 'cd'.repeat(32) as typeof DOC, title: 'Other', location: { kind: 'url', raw: 'https://elsewhere.example/o.pdf', viaPage: null }, openedAt: T0 });
    const mine = await env.api.listLocations(DOC);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ viaPage: via, documentId: DOC });
  });
});

describe('telling the other tabs, and the queue for sync', () => {
  it('announces each committed change: the document, its place and its history, then page text; Forget announces the delete', async () => {
    const env = await freshStore({ document: false });
    await env.api.saveDocument(SAMPLE_INPUT);
    const placeId = (await env.api.listLocations(DOC))[0].id;

    const seen = env.changes();
    expect(seen).toContainEqual(expect.objectContaining({ table: 'documents', op: 'upsert', ids: [DOC] }));
    expect(seen).toContainEqual(expect.objectContaining({ table: 'locations', op: 'upsert', ids: [placeId] }));
    expect(seen).toContainEqual(expect.objectContaining({ table: 'history', op: 'upsert', ids: [DOC] }));

    env.publish.mockClear();
    await env.api.putPageText(DOC, [{ pageIndex: 0, text: 'hello' }]);
    expect(env.changes()).toContainEqual(expect.objectContaining({ table: 'page_text', op: 'upsert' }));
    for (const c of env.changes()) {
      expect(c.ids.length, 'an announcement names what changed').toBeGreaterThan(0);
      expect(c.ids.every((id) => typeof id === 'string' && id !== '')).toBe(true);
    }

    env.publish.mockClear();
    await env.api.forgetDocument(DOC);
    expect(env.changes()).toContainEqual(expect.objectContaining({ table: 'documents', op: 'delete', ids: [DOC] }));
  });

  it('queues the document, its place and its reading history for sync, and never the page text or the search indexes', async () => {
    const env = await freshStore({ document: false });
    await env.api.saveDocument(SAMPLE_INPUT);
    await env.api.putPageText(DOC, [{ pageIndex: 0, text: 'pages stay on this computer' }]);
    await env.api.recordOpen(DOC, T0 + 5000);

    const queued = outboxRows(env.db);
    const tables = new Set(queued.map((r) => r.table));
    expect([...tables]).toEqual(expect.arrayContaining(['documents', 'locations', 'history']));
    expect(queued.find((r) => r.table === 'documents')).toMatchObject({ id: DOC, op: 'upsert' });
    for (const local of ['page_text', 'page_text_fts', 'documents_fts', 'comments_fts', 'page_figures', 'outbox']) {
      expect(tables.has(local), `${local} never syncs`).toBe(false);
    }
  });
});

describe('a PDF that was never saved leaves no trace', () => {
  const T = T0 + 1000;
  const ATTEMPTS: [string, (api: StoreEnv['api']) => Promise<unknown>][] = [
    ['putPageText', (api) => api.putPageText(GHOST, [{ pageIndex: 0, text: 'ghostword in a receipt' }])],
    ['recordOpen', (api) => api.recordOpen(GHOST, T)],
    ['touchLocation', (api) => api.touchLocation({ documentId: GHOST, kind: 'url', raw: 'https://ghost.example/receipt.pdf', viaPage: null, at: T })],
    ['addAlias', (api) => api.addAlias('01'.repeat(32) as never, GHOST, 0.999)],
  ];

  it.each(ATTEMPTS)('%s for an unknown document stores, indexes, queues and announces nothing (whether it refuses or does nothing)', async (_name, run) => {
    const env = await freshStore({ document: false });
    await run(env.api).catch(() => undefined);

    expect(await env.api.stats()).toEqual(ZERO_STATS);
    for (const needle of [GHOST, 'ghostword', 'ghost.example', '01'.repeat(32)]) expect(rowsMentioning(env.db, needle), `"${needle}" was stored`).toEqual([]);
    expect(await env.api.searchPages('ghostword', 5)).toEqual([]);
    expect(env.changes()).toEqual([]);
  });
});

describe('opening the library file', () => {
  it('migrate lands on schema v2 with the safety settings the spec asks for: foreign keys on, secure delete on, synchronous FULL', async () => {
    const db = await openMemoryDb();
    // Ruling N5 (backup re-check, 2 Nov): schema v4 adds the local forgotten list, so the newest version is 4 (was 3).
    expect(migrate(db)).toBe(4);
    expect(value(db, 'PRAGMA foreign_keys'), 'deleting a document must cascade').toBe(1);
    expect(value(db, 'PRAGMA secure_delete'), 'R13: deleted rows are overwritten in the file').toBe(1);
    expect(value(db, 'PRAGMA synchronous'), 'FULL: a committed note is on disk').toBe(2);
    expect(migrate(db), 'opening again changes nothing').toBe(4);
    expect(value(db, 'PRAGMA foreign_keys')).toBe(1);
  });
});
