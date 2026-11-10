// The Forget queue (D2, CL10): readings forgotten on this computer that the cloud must forget too. It sits beside the token in
// `sop-local` (meta key `cloudForget`), so it is never in a backup, an export or the library database, and survives a restart.
// The broker drains it after every sign-in, on its alarm, and when a new Forget comes in. A Forget is retried until the server
// says it is done (the call is idempotent: a reading the cloud never had, or already forgot, is done too).
//
// It holds fingerprints, which name readings the owner chose to forget, so an entry goes as soon as it is done. Only the queue
// lives here: nothing else in `sop-local` is touched, and secrets-store.ts is never imported.
import { connectLocalOnly, LOCAL_ONLY_DB, type LocalOnlyConnection } from './db';

const KEY = 'cloudForget';
const SHA = /^[0-9a-f]{64}$/;
const MAX_QUEUE = 5000;

interface Entry {
  sha: string;
  at: number;
  tries: number;
}

let connection: Promise<LocalOnlyConnection> | null = null;
const conn = (): Promise<LocalOnlyConnection> => {
  connection ??= connectLocalOnly().catch((e: unknown) => {
    connection = null;
    throw e;
  });
  return connection;
};

function parse(value: unknown): Entry[] {
  if (typeof value !== 'string') return [];
  try {
    const list = JSON.parse(value) as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter((e): e is Entry => typeof e === 'object' && e !== null && SHA.test((e as Entry).sha) && typeof (e as Entry).at === 'number').map((e) => ({ sha: e.sha, at: e.at, tries: typeof e.tries === 'number' ? e.tries : 0 }));
  } catch {
    return [];
  }
}

/** Changes the queue in one read-write transaction, so two callers at once never lose an entry. */
async function update(change: (q: Entry[]) => Entry[]): Promise<Entry[]> {
  const c = await conn();
  return c.transact<Entry[]>('meta', 'readwrite', (store, answer) => {
    const r = store.get(KEY);
    r.onsuccess = () => {
      const next = change(parse((r.result as { value?: unknown } | undefined)?.value)).slice(-MAX_QUEUE);
      if (next.length === 0) store.delete(KEY);
      else store.put({ key: KEY, value: JSON.stringify(next) });
      answer(next);
    };
  });
}

export async function queuedForgets(): Promise<string[]> {
  return (await queued()).map((e) => e.sha);
}

async function queued(): Promise<Entry[]> {
  try {
    if (!(await indexedDB.databases()).some((db) => db.name === LOCAL_ONLY_DB)) return [];
  } catch {
    // cannot tell: read it
  }
  const c = await conn();
  const raw = await c.transact<unknown>('meta', 'readonly', (store, answer) => {
    const r = store.get(KEY);
    r.onsuccess = () => answer((r.result as { value?: unknown } | undefined)?.value);
  });
  return parse(raw);
}

export async function enqueueForget(sha: string, now = Date.now()): Promise<void> {
  if (!SHA.test(sha)) throw new TypeError('A fingerprint is 64 lower-case hex characters.');
  await update((q) => (q.some((e) => e.sha === sha) ? q : [...q, { sha, at: now, tries: 0 }]));
}

/**
 * Sends each queued Forget with `forget`, with the time the owner chose it (a new save after that time syncs again) (the sync client's `DELETE /api/documents/:sha`). An entry leaves the queue once it
 * succeeds; one that fails stays for the next try. Stops at the first failure that is not about that one reading (offline,
 * signed out). Answers how many are still waiting.
 */
export async function drainForgets(forget: (sha: string, at: number) => Promise<'done' | 'retry' | 'stop'>): Promise<number> {
  const list = await queued();
  for (const { sha, at } of list) {
    const r = await forget(sha, at);
    if (r === 'done') await update((q) => q.filter((e) => e.sha !== sha));
    else {
      await update((q) => q.map((e) => (e.sha === sha ? { ...e, tries: e.tries + 1 } : e)));
      if (r === 'stop') break;
    }
  }
  return (await queuedForgets()).length;
}
