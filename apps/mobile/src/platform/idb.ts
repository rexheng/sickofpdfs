// A small key-value store in IndexedDB (`sop-mobile`, object store `files`) for the app's own bookkeeping: which storage this
// phone uses (storage-mode.ts) and, on a WebView without OPFS, the fallback's database and saved PDFs. Pages and workers both use it.
const DB_NAME = 'sop-mobile';
const STORE = 'files';

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB would not open'));
  }).catch((e: unknown) => {
    opening = null;
    throw e;
  });
  return opening;
}

async function run<T>(mode: IDBTransactionMode, act: (s: IDBObjectStore) => IDBRequest<T> | null): Promise<T | undefined> {
  const db = await open();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, mode, { durability: 'strict' });
    const req = act(tx.objectStore(STORE));
    let value: T | undefined;
    if (req !== null) req.onsuccess = () => (value = req.result);
    // A write counts once the transaction is committed, not when the request succeeds.
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export const idbGet = <T>(key: string): Promise<T | undefined> => run<T>('readonly', (s) => s.get(key) as IDBRequest<T>);
export const idbPut = async (key: string, value: unknown): Promise<void> => void (await run('readwrite', (s) => s.put(value, key)));
export const idbDelete = async (key: string): Promise<void> => void (await run('readwrite', (s) => s.delete(key)));
export const idbHas = async (key: string): Promise<boolean> => ((await run<number>('readonly', (s) => s.count(key))) ?? 0) > 0;
