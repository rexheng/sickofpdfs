// Test support only: the real store API over an in-memory SQLite, with a clock and a change recorder the test controls.
// Uses Task 28's published names: migrate(db), createStoreApi(db, { now, hlc, publish }), Hlc.
import { vi } from 'vitest';
import { Hlc } from '../../../../packages/core/src/hlc';
import { openMemoryDb, type Db } from './db.spec-blind';
import { migrate } from './migrate';
import { createStoreApi } from './store-api';
import type { StoreChange } from './change-bus';
import { SAMPLE_INPUT, SAMPLE_INPUT_2 } from './rows.spec-blind';

export interface StoreEnv {
  db: Db;
  api: ReturnType<typeof createStoreApi>;
  clock: { t: number };
  publish: ReturnType<typeof vi.fn<(c: StoreChange) => void>>;
  changes(): StoreChange[];
}

/** Wraps an already-migrated database. `deviceId` is only used in the hybrid clock stamps. */
export function wrapStore(db: Db, deviceId = 'devA'): StoreEnv {
  const clock = { t: 1_700_000_000_000 };
  const publish = vi.fn<(c: StoreChange) => void>();
  const api = createStoreApi(db, { now: () => clock.t, hlc: new Hlc(deviceId, () => clock.t), publish });
  return { db, api, clock, publish, changes: () => publish.mock.calls.map((c) => c[0]) };
}

/** A fresh database at the current schema, with one saved document (DOC) so notes have something to belong to. */
export async function freshStore(opts: { document?: boolean } = {}): Promise<StoreEnv> {
  const db = await openMemoryDb();
  migrate(db);
  const env = wrapStore(db);
  if (opts.document !== false) {
    await env.api.saveDocument(SAMPLE_INPUT);
    quiet(env);
  }
  return env;
}

/** Forgets what saving a document queued and announced, so a test sees only what it does itself. */
export function quiet(env: StoreEnv): void {
  env.db.exec('DELETE FROM outbox');
  env.publish.mockClear();
}

/** Saves the second sample document (DOC2) and goes quiet again. */
export async function saveSecondDocument(env: StoreEnv): Promise<void> {
  await env.api.saveDocument(SAMPLE_INPUT_2);
  quiet(env);
}
