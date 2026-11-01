// Reads the whole library for a backup or an export, a piece at a time (store/backup-api.ts `exportChunk`), so the store worker can
// answer a viewer's request between two pieces. The pieces must fit together: if the library was written to in between, the store says
// so and the read starts again. A library that keeps changing (a note being typed) is read in one go after three tries.
import { type DumpTable, emptyTables, type LibraryDump, type LibraryTables } from '@sop/core';
import type { ExportCursor, ExportChunk } from '../store/backup-api';
import type { StoreApi } from '../store/store-api';

/** Rows asked for at a time. About 15 ms of the store worker's time. */
export const CHUNK_ROWS = 400;
const TRIES = 3;

export async function readLibrary(store: Pick<StoreApi, 'exportChunk' | 'exportLibrary'>, rows: number = CHUNK_ROWS): Promise<LibraryDump> {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const tables = emptyTables() as unknown as Record<DumpTable, unknown[]>;
    let cursor: ExportCursor | null = null;
    let stale = false;
    do {
      const chunk: ExportChunk = await store.exportChunk(cursor, rows);
      if (chunk.stale) {
        stale = true;
        break;
      }
      for (const row of chunk.rows) tables[chunk.table].push(row);
      cursor = chunk.next;
    } while (cursor !== null);
    if (!stale) return { tables: tables as unknown as LibraryTables };
  }
  return store.exportLibrary();
}
