// Test support only: a store worker for the browser durability test. It opens the SQLite file in OPFS the way the real store
// worker does (the SAH pool VFS), and answers a few commands. Killing it (Worker.terminate) is the stand-in for a crash.
/// <reference lib="webworker" />
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { Hlc } from '../../../../packages/core/src/hlc';
import { migrate } from './migrate';
import { createStoreApi } from './store-api';
import { fillV1 } from './v1-data.spec-blind';
import { commentRow, DOC, markRow, T_A, T_B, textAnchor, threadRow, draftRow } from './rows.spec-blind';

type Msg = { id: number; cmd: 'seedV1' | 'upgradeAndWrite' | 'read'; dir: string };

async function open(dir: string) {
  const sqlite3 = await sqlite3InitModule();
  let lastError: unknown;
  for (let i = 0; i < 30; i++) {
    try {
      const pool = await sqlite3.installOpfsSAHPoolVfs({ name: `sop-test-${dir}`, directory: `/${dir}`, initialCapacity: 6, clearOnInit: false });
      return new pool.OpfsSAHPoolDb('/library.sqlite3');
    } catch (e) {
      lastError = e; // a killed worker's file handles are let go a moment later
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw lastError;
}

self.onmessage = async (e: MessageEvent<Msg>) => {
  const { id, cmd, dir } = e.data;
  try {
    const db = await open(dir);
    let value: unknown;
    if (cmd === 'seedV1') {
      fillV1(db);
      value = { userVersion: db.selectValue('PRAGMA user_version') };
    } else {
      const upgraded = migrate(db);
      const api = createStoreApi(db, { now: () => 1_700_000_100_000, hlc: new Hlc('devOPFS', () => 1_700_000_100_000), publish: () => undefined });
      if (cmd === 'upgradeAndWrite') {
        await api.writeAnnotations([
          { table: 'threads', op: 'upsert', row: threadRow({ id: 'new-thread', anchor: textAnchor(1, 3, 40), createdAt: 1_700_000_050_000 }) },
          { table: 'comments', op: 'upsert', row: commentRow({ id: 'new-comment', threadId: 'new-thread', body: 'sent before the kill', createdAt: 1_700_000_050_000 }) },
          { table: 'marks', op: 'soft-delete', row: markRow({ id: 'm2' }) },
        ]);
        await api.saveDraft(draftRow({ id: 'new-draft', threadId: 'new-draft-thread', body: 'typed just before the kill', draftOfTab: T_B }), threadRow({ id: 'new-draft-thread', draftOfTab: T_B, anchor: textAnchor(0, 4, 29) }));
      }
      const notes = await api.listAnnotations(DOC);
      value = {
        upgraded,
        userVersion: db.selectValue('PRAGMA user_version'),
        marks: notes.marks.map((m) => m.id).sort(),
        threads: notes.threads.map((t) => t.id).sort(),
        comments: notes.comments.map((c) => [c.id, c.body]).sort(),
        draftsOfOldTab: (await api.listDrafts(DOC, 'old-tab-1' as never)).map((c) => [c.id, c.body]),
        draftsOfB: (await api.listDrafts(DOC, T_B)).map((c) => [c.id, c.body]),
        draftsOfA: (await api.listDrafts(DOC, T_A)).map((c) => c.id),
      };
    }
    // no db.close(): the next thing that happens to this worker is terminate()
    (self as unknown as Worker).postMessage({ id, ok: true, value });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String(err) });
  }
};
