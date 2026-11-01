/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- one table of cases handles the rows of eight different tables */
// Spec-blind table tests for the restore merge (Phase 3, pack T3): what "Restore from backup" does when it meets a library that
// already has things in it.
//
// Sources: spec "Backups" ("'Restore from backup' in Settings rebuilds the library on a fresh install, merging by fingerprint and
// id"), contracts section 5 ("Restore merges by fingerprint and id. The newer `hlc` wins, and nothing local is deleted"; the
// backup's `library.json` is the camelCase rows of documents, aliases, locations, marks, threads, comments, history and settings;
// "drafts excluded"), the plan's "Test packs" (restore merge: idempotent, newer wins, nothing deleted, aliases), contracts section
// 4 (alias rule: R59; a soft delete is a `deletedAt`, Trash restores it), spec "Identity rules" (a document's id is its
// fingerprint; a stamped re-download is an alias, never also a document), CLAUDE.md ("no lost notes").
//
// How the tests read a restore: the kit finds the function, works out how it is called, and applies whatever rows it hands back
// to the local library. Every assertion is about the library afterwards. Both libraries are deep-frozen first, so a restore that
// edits its input throws.
import { describe, expect, it } from 'vitest';
import {
  TABLE_NAMES,
  byKey,
  canonical,
  emptyTables,
  integrityProblems,
  restore,
  tables,
  type TableName,
  type Tables,
} from '../../test/spec-blind/backup-kit';
import {
  MIN,
  T0,
  aliasRow,
  claudeMeta,
  commentRow,
  documentRow,
  hex64,
  historyRow,
  locationRow,
  markRow,
  settingRow,
  stamp,
  threadRow,
  uuid,
} from '../../test/spec-blind/p3-rows';

const D1 = hex64('d1');
const D2 = hex64('d2');
const D3 = hex64('d3');
const A1 = hex64('a1');
const T_ONE = uuid(1, 't');

/** A small library: three documents (one in Trash), an alias, notes with a reply from Claude, history and a setting. */
function library(ms = T0): Tables {
  const hlc = stamp(ms);
  return tables({
    documents: [
      documentRow(D1, { title: 'Paper one', hlc }),
      documentRow(D2, { title: 'Book two', kind: 'book', hlc }),
      documentRow(D3, { title: 'Thrown away', deletedAt: T0 + MIN, hlc }),
    ],
    aliases: [aliasRow(A1, D1, { hlc })],
    locations: [
      locationRow(D1, { canonical: 'https://example.org/one.pdf', hlc }),
      locationRow(D2, { kind: 'file', canonical: 'file:///books/two.pdf', hlc }),
    ],
    marks: [markRow({ id: uuid(1, 'm'), documentId: D1, page: 0, hlc }), markRow({ id: uuid(2, 'm'), documentId: D2, page: 3, style: 'bold', hlc })],
    threads: [threadRow({ id: T_ONE, documentId: D1, page: 0, hlc })],
    comments: [
      commentRow({ id: uuid(1, 'c'), threadId: T_ONE, documentId: D1, body: 'first note', hlc }),
      commentRow({ id: uuid(2, 'c'), threadId: T_ONE, documentId: D1, body: 'a reply', author: 'claude', createdAt: T0 + MIN, meta: claudeMeta(), hlc }),
    ],
    history: [historyRow(D1, { hlc })],
    settings: [settingRow('library.layout', 'grid', { hlc })],
  });
}

/** A library that has been used since the backup: edits made here, things only here, and one setting older than the backup's. */
function usedSince(): Tables {
  const later = stamp(T0 + 30 * MIN, 'dev-b');
  const mine = hex64('b1');
  return tables({
    documents: [documentRow(D1, { title: 'Paper one (renamed here)', hlc: later }), documentRow(mine, { title: 'Only on this computer', hlc: later })],
    threads: [threadRow({ id: uuid(9, 't'), documentId: mine, page: 1, hlc: later })],
    comments: [commentRow({ id: uuid(9, 'c'), threadId: uuid(9, 't'), documentId: mine, body: 'LOCALNOTE', hlc: later })],
    settings: [settingRow('library.layout', 'list', { hlc: stamp(T0 - MIN, 'dev-b') })],
  });
}

describe('restore: a fresh profile', () => {
  it('brings back every row of every table, exactly as the backup holds it', async () => {
    const backup = library();
    const out = await restore(emptyTables(), backup);
    expect(canonical(out.after)).toEqual(canonical(backup));
    expect(out.deletes).toEqual([]);
    expect(integrityProblems(out.after)).toEqual([]);
  });

  it('restoring a library onto itself changes nothing', async () => {
    const backup = library();
    const out = await restore(backup, backup);
    expect(canonical(out.after)).toEqual(canonical(backup));
  });
});

describe('restore: idempotent', () => {
  const starts: [name: string, local: () => Tables][] = [
    ['an empty library', emptyTables],
    ['a library with its own notes', usedSince],
  ];
  it.each(starts)('restoring twice, or three times, gives what restoring once gives: %s', async (_name, start) => {
    const backup = library();
    const once = await restore(start(), backup);
    const twice = await restore(once.after, backup);
    const thrice = await restore(twice.after, backup);
    expect(canonical(twice.after)).toEqual(canonical(once.after));
    expect(canonical(thrice.after)).toEqual(canonical(once.after));
    // not one note, mark or alias twice
    for (const table of TABLE_NAMES) expect(thrice.after[table].length, table).toBe(once.after[table].length);
  });
});

describe('restore: the newer stamp wins', () => {
  const OLD = T0;
  const NEW = T0 + 10 * MIN;
  const parents = { documents: [documentRow(D1, { hlc: stamp(T0) })] } as Partial<Tables>;
  const withThread = { ...parents, threads: [threadRow({ id: T_ONE, documentId: D1, page: 0, hlc: stamp(T0) })] } as Partial<Tables>;
  type Side = 'local' | 'backup';
  interface Kind {
    table: TableName;
    /** A row, saying which side it is from in one field. A row with a newer stamp gets the smaller `rev`, so a revision number cannot decide. */
    make(side: Side, ms: number, rev: number): any;
    read(row: any): unknown;
    parents?: Partial<Tables>;
  }
  const KINDS: Kind[] = [
    { table: 'documents', make: (s, ms, rev) => documentRow(D1, { title: `title from ${s}`, hlc: stamp(ms), rev }), read: (r) => r.title },
    // triage: aliases are not here. As in sync (contracts section 7), two aliases of one fingerprint merge field by field; see below.
    { table: 'locations', parents, make: (s, ms, rev) => locationRow(D1, { canonical: 'https://example.org/one.pdf', viaPage: `https://example.org/${s}`, hlc: stamp(ms), rev }), read: (r) => r.viaPage },
    { table: 'marks', parents, make: (s, ms, rev) => ({ ...markRow({ id: uuid(1, 'm'), documentId: D1, page: 0, color: s === 'local' ? 1 : 3, hlc: stamp(ms) }), rev }), read: (r) => r.color },
    { table: 'threads', parents, make: (s, ms, rev) => ({ ...threadRow({ id: T_ONE, documentId: D1, page: 0, hlc: stamp(ms) }), placement: s === 'local' ? 'placed' : 'unplaced', rev }), read: (r) => r.placement },
    { table: 'comments', parents: withThread, make: (s, ms, rev) => ({ ...commentRow({ id: uuid(1, 'c'), threadId: T_ONE, documentId: D1, body: `body from ${s}`, hlc: stamp(ms) }), rev }), read: (r) => r.body },
    { table: 'history', parents, make: (s, ms, rev) => historyRow(D1, { lastPosition: { page: s === 'local' ? 3 : 9, offset: 0.1, zoom: 1 }, hlc: stamp(ms), rev }), read: (r) => r.lastPosition.page },
    { table: 'settings', make: (s, ms, rev) => settingRow('library.layout', `from ${s}`, { hlc: stamp(ms), rev }), read: (r) => r.value },
  ];

  const run = async (k: Kind, localMs: number, backupMs: number) => {
    const local = tables({ ...k.parents, [k.table]: [k.make('local', localMs, localMs === NEW ? 1 : 9)] });
    const backup = tables({ ...k.parents, [k.table]: [k.make('backup', backupMs, backupMs === NEW ? 1 : 9)] });
    const out = await restore(local, backup);
    const rows = out.after[k.table] as any[];
    expect(rows, `one ${k.table} row, not two`).toHaveLength(1);
    return rows[0];
  };

  it.each(KINDS)('$table: a newer backup row replaces the local one, and an older one does not', async (k) => {
    const fromBackup = await run(k, OLD, NEW);
    expect(k.read(fromBackup), 'the backup row is newer').toBe(k.read(k.make('backup', 0, 0)));
    expect(fromBackup.hlc, 'it keeps the stamp it was written with').toBe(stamp(NEW));
    const fromLocal = await run(k, NEW, OLD);
    expect(k.read(fromLocal), 'the local row is newer').toBe(k.read(k.make('local', 0, 0)));
    expect(fromLocal.hlc).toBe(stamp(NEW));
  });

  it('aliases (triage: as sync merges them): for one document, the earliest createdAt, the highest similarity and the newer stamp', async () => {
    const a = (similarity: number, createdAt: number, ms: number) => aliasRow(A1, D1, { similarity, createdAt, hlc: stamp(ms) });
    for (const [local, backup] of [[a(0.996, T0 + MIN, NEW), a(0.999, T0, OLD)], [a(0.999, T0, OLD), a(0.996, T0 + MIN, NEW)]]) {
      const out = await restore(tables({ ...parents, aliases: [local] }), tables({ ...parents, aliases: [backup] }));
      expect(out.after.aliases).toHaveLength(1);
      expect(out.after.aliases[0]).toMatchObject({ documentId: D1, similarity: 0.999, createdAt: T0, hlc: stamp(NEW) });
    }
  });

  it('stamps are compared as stamps: by time, then counter, then device, not as text', async () => {
    // The counter is hex: 0x000a is more than 0x0009. At the same time and counter the device name breaks the tie.
    const k = KINDS[0];
    const mk = (side: Side, hlc: string) => documentRow(D1, { title: `title from ${side}`, hlc });
    const cases: [local: string, backup: string, winner: Side][] = [
      [stamp(T0, 'dev-a', 9), stamp(T0, 'dev-b', 10), 'backup'],
      [stamp(T0, 'dev-a', 10), stamp(T0, 'dev-b', 9), 'local'],
      [stamp(T0, 'dev-a', 1), stamp(T0, 'dev-b', 1), 'backup'],
      [stamp(T0 + 1, 'dev-a', 0), stamp(T0, 'dev-z', 65535), 'local'],
    ];
    for (const [l, b, winner] of cases) {
      const out = await restore(tables({ documents: [mk('local', l)] }), tables({ documents: [mk('backup', b)] }));
      expect(k.read(out.after.documents[0]), `${l} against ${b}`).toBe(`title from ${winner}`);
    }
  });
});

describe('restore: nothing local is deleted', () => {
  it('rows that only this computer has stay, in every table, and so does everything the backup has', async () => {
    const local = library(T0 - 60 * MIN);
    const backup = tables({
      documents: [documentRow(hex64('b2'), { title: 'Only in the backup' })],
      threads: [threadRow({ id: uuid(5, 't'), documentId: hex64('b2'), page: 0 })],
      comments: [commentRow({ id: uuid(5, 'c'), threadId: uuid(5, 't'), documentId: hex64('b2'), body: 'only in the backup' })],
      settings: [settingRow('lookups.online', 'false')],
    });
    const out = await restore(local, backup);
    for (const table of TABLE_NAMES) {
      const after = byKey(out.after, table);
      for (const [key, row] of byKey(local, table)) expect(after.get(key), `${table} ${key} (from this computer)`).toEqual(row);
      for (const [key, row] of byKey(backup, table)) expect(after.get(key), `${table} ${key} (from the backup)`).toEqual(row);
    }
    expect(out.deletes, 'no hard delete in the plan').toEqual([]);
    expect(integrityProblems(out.after)).toEqual([]);
  });

  const deletable = [
    { table: 'documents', make: (ms: number, deleted: boolean) => documentRow(D1, { hlc: stamp(ms), deletedAt: deleted ? ms : null }) },
    { table: 'marks', make: (ms: number, deleted: boolean) => markRow({ id: uuid(1, 'm'), documentId: D1, page: 0, hlc: stamp(ms), deletedAt: deleted ? ms : null }) },
    { table: 'threads', make: (ms: number, deleted: boolean) => threadRow({ id: T_ONE, documentId: D1, page: 0, hlc: stamp(ms), deletedAt: deleted ? ms : null }) },
    { table: 'comments', make: (ms: number, deleted: boolean) => commentRow({ id: uuid(1, 'c'), threadId: T_ONE, documentId: D1, body: 'a note', hlc: stamp(ms), deletedAt: deleted ? ms : null }) },
  ] as const;

  it.each(deletable)('$table: what you deleted after the backup was made stays deleted; a later edit, or Trash restored after the backup, stays', async ({ table, make }) => {
    const parents = { documents: [documentRow(D1, { hlc: stamp(T0) })], threads: [threadRow({ id: T_ONE, documentId: D1, page: 0, hlc: stamp(T0) })] } as Partial<Tables>;
    const build = (row: unknown) => tables({ ...(table === 'documents' ? {} : parents), [table]: [row] });
    const OLD = T0;
    const NEW = T0 + 20 * MIN;
    const deletedLater = await restore(build(make(NEW, true)), build(make(OLD, false)));
    expect((deletedLater.after[table][0] as { deletedAt: number | null }).deletedAt, 'deleted here, after the backup').not.toBeNull();
    const restoredLater = await restore(build(make(NEW, false)), build(make(OLD, true)));
    expect((restoredLater.after[table][0] as { deletedAt: number | null }).deletedAt, 'the backup only has the old Trash state').toBeNull();
    // "An edit beats a delete" (spec, sync rules): the backup holds a later change to what was deleted here earlier
    const editedLater = await restore(build(make(OLD, true)), build(make(NEW, false)));
    expect((editedLater.after[table][0] as { deletedAt: number | null }).deletedAt, 'the backup row is newer than the delete').toBeNull();
  });
});

describe('restore: aliases', () => {
  it('an alias comes back with its document, is added to a document that lacks it, and a local alias is kept', async () => {
    const backup = library();
    const fresh = await restore(emptyTables(), backup);
    expect(byKey(fresh.after, 'aliases').get(A1)?.documentId, 'the alias goes to the first copy').toBe(D1);
    expect(byKey(fresh.after, 'documents').has(D1)).toBe(true);

    const hasDocOnly = await restore(tables({ documents: [documentRow(D1, { hlc: stamp(T0) })] }), backup);
    expect(byKey(hasDocOnly.after, 'aliases').get(A1)?.documentId).toBe(D1);

    const A2 = hex64('a2');
    const local = tables({ documents: [documentRow(D2, { hlc: stamp(T0) })], aliases: [aliasRow(A2, D2)] });
    const both = await restore(local, backup);
    expect(byKey(both.after, 'aliases').get(A2)?.documentId, 'a local alias is not dropped').toBe(D2);
    expect(byKey(both.after, 'aliases').get(A1)?.documentId).toBe(D1);
    expect(integrityProblems(both.after)).toEqual([]);
  });

  it('a file that is an alias in the backup is never also a document: the note written on it here is not lost', async () => {
    // On a fresh install the owner re-downloaded paper one, got a stamped copy, and wrote a note on it before restoring.
    // That copy was saved as its own document, with the new fingerprint A1. The backup knows A1 as an alias of D1.
    const local = tables({
      documents: [documentRow(A1, { title: 'Paper one (re-download)', hlc: stamp(T0 + 5 * MIN, 'dev-b') })],
      threads: [threadRow({ id: uuid(7, 't'), documentId: A1, page: 0, hlc: stamp(T0 + 5 * MIN, 'dev-b') })],
      comments: [commentRow({ id: uuid(7, 'c'), threadId: uuid(7, 't'), documentId: A1, body: 'LOCALNOTE', hlc: stamp(T0 + 5 * MIN, 'dev-b') })],
    });
    const out = await restore(local, library());
    const docs = new Set(out.after.documents.map((d) => d.id as string));
    for (const a of out.after.aliases) expect(docs.has(a.sha256), `${a.sha256.slice(0, 4)}... is both a document and an alias`).toBe(false);
    expect(out.after.comments.some((c) => c.body === 'LOCALNOTE'), 'the note written here is still in the library').toBe(true);
    expect(out.after.documents.some((d) => d.id === D1), 'and the backup\'s own document is back').toBe(true);
    expect(integrityProblems(out.after)).toEqual([]);
  });
});
