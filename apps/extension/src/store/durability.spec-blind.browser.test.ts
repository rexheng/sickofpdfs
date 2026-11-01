// Spec-blind test for the store in a real browser (OPFS), slice S2: an upgrade and a crash on the real file.
//
// Sources:
//   plan Phase 2, S2: "a v1 database upgrades with nothing lost" and done-when 10 "A filled v1 database upgrades to schema v2
//     with nothing lost"; done-when 5 / contracts section 3: a draft typed just before the crash is back after reopening.
//   spec, Storage: the database is SQLite in the origin private file system, owned by one background page.
// What it does: worker A makes a filled v1 database in OPFS and is killed; worker B upgrades it, sends a note, types a draft
// and is killed without closing the database; worker C opens the file and must find everything. The workers use the same
// SAH-pool file layer the real store worker uses (Task 28); the store code under test runs inside them.
import { afterEach, describe, expect, it } from 'vitest';
import { DOC } from './rows.spec-blind';

const dirs: string[] = [];
const workers: Worker[] = [];
afterEach(async () => {
  for (const w of workers.splice(0)) w.terminate();
  const root = await navigator.storage.getDirectory();
  for (const d of dirs.splice(0)) await root.removeEntry(d, { recursive: true }).catch(() => undefined);
});

/** Starts a worker, asks it one thing, and kills it. */
async function once<T>(cmd: 'seedV1' | 'upgradeAndWrite' | 'read', dir: string): Promise<T> {
  const worker = new Worker(new URL('./opfs-peer.spec-blind.worker.ts', import.meta.url), { type: 'module' });
  workers.push(worker);
  try {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker did not answer ${cmd}`)), 20_000);
      worker.onmessage = (e: MessageEvent<{ ok: boolean; value?: T; error?: string }>) => {
        clearTimeout(timer);
        if (e.data.ok) resolve(e.data.value as T);
        else reject(new Error(e.data.error));
      };
      worker.onerror = (e) => reject(new Error(e.message));
      worker.postMessage({ id: 1, cmd, dir });
    });
  } finally {
    worker.terminate();
  }
}

describe('the real file', () => {
  it('a v1 database upgrades, and a sent note and a typed draft survive the worker being killed', async () => {
    const dir = `sop-test-${crypto.randomUUID()}`;
    dirs.push(dir);

    expect(await once<{ userVersion: number }>('seedV1', dir)).toEqual({ userVersion: 1 });

    const second = await once<{ userVersion: number; marks: string[]; comments: string[][]; draftsOfOldTab: string[][]; draftsOfB: string[][] }>('upgradeAndWrite', dir);
    expect(second.userVersion).toBe(3);
    expect(second.marks).toEqual(['m1', 'm3']); // m2 was deleted by this run, m4 was already deleted in v1
    expect(second.draftsOfB).toEqual([['new-draft', 'typed just before the kill']]);

    const third = await once<{ userVersion: number; marks: string[]; threads: string[]; comments: string[][]; draftsOfOldTab: string[][]; draftsOfB: string[][]; draftsOfA: string[] }>('read', dir);
    expect(third.userVersion).toBe(3);
    expect(third.marks).toEqual(['m1', 'm3']);
    expect(third.threads).toEqual(['new-thread', 't1', 't2', 't3']);
    expect(third.comments.map((c) => c[0])).toEqual(['c1', 'c2', 'c3', 'c4', 'new-comment']);
    expect(third.comments.find((c) => c[0] === 'new-comment')![1]).toBe('sent before the kill');
    expect(third.draftsOfOldTab).toEqual([['c5', 'unsent thought about quokkas']]); // the v1 draft is still waiting for whoever adopts it
    expect(third.draftsOfB).toEqual([['new-draft', 'typed just before the kill']]);
    expect(third.draftsOfA).toEqual([]);
    expect(DOC).toHaveLength(64);
  });
});
