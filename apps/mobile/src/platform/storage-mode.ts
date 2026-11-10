// Which storage this phone's library uses. store-worker.ts chooses it once and remembers it in IndexedDB (idb.ts).

/** "opfs": SQLite in the phone's private file storage, as in Chrome. "idb": the fallback in IndexedDB. */
export type StorageMode = 'opfs' | 'idb';

export const STORAGE_MODE_KEY = 'storage-mode';
