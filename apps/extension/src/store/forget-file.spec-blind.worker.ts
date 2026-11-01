// Test support only: a store worker for the Forget-on-disk browser test. It opens the library file in OPFS exactly as the real store
// worker does (the SAH pool file layer, then `migrate`), fills it, or forgets one PDF, and reports the file settings it ended up with.
/// <reference lib="webworker" />
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { Hlc } from '../../../../packages/core/src/hlc';
import { migrate } from './migrate';
import { createStoreApi } from './store-api';
import { DOC, DOC2, SAMPLE_INPUT } from './rows.spec-blind';

type Msg = { id: number; cmd: 'fill' | 'forget'; dir: string };

async function open(dir: string) {
  const sqlite3 = await sqlite3InitModule();
  let lastError: unknown;
  for (let i = 0; i < 30; i++) {
    try {
      const pool = await sqlite3.installOpfsSAHPoolVfs({ name: `sop-forget-${dir}`, directory: `/${dir}`, initialCapacity: 6, clearOnInit: false });
      return new pool.OpfsSAHPoolDb('/library.sqlite3');
    } catch (e) {
      lastError = e; // a stopped worker's file handles are let go a moment later
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw lastError;
}

self.onmessage = async (e: MessageEvent<Msg>) => {
  const { id, cmd, dir } = e.data;
  try {
    const db = await open(dir);
    migrate(db);
    const settings = Object.fromEntries(['journal_mode', 'secure_delete', 'synchronous', 'foreign_keys', 'user_version'].map((p) => [p, db.selectValue(`PRAGMA ${p}`)]));
    const api = createStoreApi(db, { now: () => 1_700_000_100_000, hlc: new Hlc('devOPFS', () => 1_700_000_100_000), publish: () => undefined });
    if (cmd === 'fill') {
      await api.saveDocument({ ...SAMPLE_INPUT, title: 'The Quokkanomics handbook', authors: ['Ximena Zibbleton'], location: { kind: 'url', raw: 'https://quokka-links.example/papers/q.pdf', viaPage: null } });
      await api.saveDocument({ ...SAMPLE_INPUT, id: DOC2, title: 'Marmoset ecology', authors: ['Bartholomew Tamarin'], location: null });
      await api.putPageText(DOC, [{ pageIndex: 0, text: 'Chapter one about the platypusword economy.' }, { pageIndex: 1, text: 'Chapter two: the echidnaword effect.' }]);
      await api.putPageText(DOC2, [{ pageIndex: 0, text: 'Gibbonword habitat survey of the canopy.' }]);
      await api.recordOpen(DOC, 1_700_000_100_500);
    } else {
      await api.forgetDocument(DOC);
    }
    db.close();
    (self as unknown as Worker).postMessage({ id, ok: true, value: { settings } });
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String(error instanceof Error ? error.stack ?? error.message : error) });
  }
};
