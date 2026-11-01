// This browser profile's device id: 128 random bits as hex, made once and then kept. It is the last part of every HLC
// stamp the store writes, so sync (Phase 5) can tell devices apart. It lives in its own IndexedDB database, outside the
// library, so it is never in a backup or an export. It is not a secret, and this file never touches the secrets store.

// IndexedDB `sop-device` version 1, object store `meta`, key `deviceId` (plan, Task 29 section).
const DB_NAME = 'sop-device';
const STORE = 'meta';
const KEY = 'deviceId';
const DEVICE_ID = /^[0-9a-f]{32}$/;

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function openDeviceDb(): Promise<IDBDatabase> {
  const open = indexedDB.open(DB_NAME, 1);
  open.onupgradeneeded = () => {
    if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
  };
  return request(open);
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The device id, made on the first call and the same ever after. The read and the first write are one IndexedDB
 * transaction, so two callers at once still end up with one id.
 */
export async function ensureDeviceId(): Promise<string> {
  const db = await openDeviceDb();
  try {
    return await new Promise<string>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      let id: string | null = null;
      const get = store.get(KEY);
      get.onsuccess = () => {
        const found: unknown = get.result;
        if (typeof found === 'string' && DEVICE_ID.test(found)) {
          id = found;
          return;
        }
        id = randomId();
        store.put(id, KEY);
      };
      tx.oncomplete = () => (id === null ? reject(new Error('no device id')) : resolve(id));
      tx.onerror = () => reject(tx.error ?? new Error('the device id could not be saved'));
      tx.onabort = () => reject(tx.error ?? new Error('the device id could not be saved'));
    });
  } finally {
    db.close();
  }
}
