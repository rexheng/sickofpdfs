// Spec-blind browser test for Task 29: the device id.
//
// Sources (interface file, Task 29):
//   ensureDeviceId(): Promise<string> — "random 128-bit hex, created once"; "its own IndexedDB 'sop-device' v1, store 'meta', key 'deviceId'";
//   "never in backups, so a restored install gets a new id" (Task 28 interface: "created once, never in backups").
//   spec, Sync rules: "Every change carries ... a hybrid clock, not the computer's wall clock"; "Ids never duplicate across devices": two devices
//     sharing one id would break the clock's tie-break and make one device's edits look like the other's.
// What it does: several workers (each a separate copy of the module, as several tabs are) ask at the same moment on a fresh install; then
// the test reads the IndexedDB directly; then the database is removed (a restore onto a new install) and a new id must appear.
import { afterEach, describe, expect, it } from 'vitest';

const workers: Worker[] = [];
afterEach(() => {
  for (const w of workers.splice(0)) w.terminate();
});

function askInNewContext(): Promise<{ id: string; again: string }> {
  const worker = new Worker(new URL('./device-id.spec-blind.worker.ts', import.meta.url), { type: 'module' });
  workers.push(worker);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer from the device id')), 20_000);
    worker.onmessage = (e: MessageEvent<{ ok: boolean; id: string; again: string; error?: string }>) => {
      clearTimeout(timer);
      if (e.data.ok) resolve(e.data);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage({});
  });
}

/** Closes the workers (their connections), then removes the database as a fresh install would have it. */
async function freshInstall(): Promise<void> {
  for (const w of workers.splice(0)) w.terminate();
  await new Promise((r) => setTimeout(r, 200));
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('sop-device');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error('could not remove sop-device'));
    request.onblocked = () => setTimeout(() => resolve(), 2000); // a connection still open; the delete finishes when it closes
  });
}

async function storedId(): Promise<{ version: number; stores: string[]; id: unknown }> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('sop-device');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('cannot open sop-device'));
  });
  try {
    const stores = [...db.objectStoreNames];
    const id = stores.includes('meta') ? await new Promise((resolve, reject) => {
      const get = db.transaction('meta').objectStore('meta').get('deviceId');
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(new Error('cannot read deviceId'));
    }) : undefined;
    return { version: db.version, stores, id };
  } finally {
    db.close();
  }
}

describe('the device id', () => {
  it('is made once, even when many tabs ask at the same moment on a fresh install; it is 128 random bits in hex, kept where the spec says', async () => {
    await freshInstall();

    const answers = await Promise.all(Array.from({ length: 8 }, askInNewContext));

    const ids = new Set(answers.flatMap((a) => [a.id, a.again]));
    expect([...ids], 'every tab sees the same id').toHaveLength(1);
    const [id] = [...ids];
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(await storedId()).toEqual({ version: 1, stores: ['meta'], id });

    // a tab opened later, after all of that, still gets it
    expect((await askInNewContext()).id).toBe(id);
  });

  it('a new install (the database gone, as after a restore from backup) gets a different id, not the old one', async () => {
    await freshInstall();
    const first = (await askInNewContext()).id;
    await freshInstall();
    const second = (await askInNewContext()).id;
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
  });
});
