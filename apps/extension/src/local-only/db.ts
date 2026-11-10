// The local-only database ("sop-local") itself: its name, its object stores and the code that opens it. Moved here unchanged
// from secrets-store.ts (CL10, contracts CA7), so the cloud token broker can open the same database the same way, and can
// never create a half-built one, without importing the secrets store.
//
// WHO MAY IMPORT THIS FILE: what may import secrets-store.ts, plus the two cloud files beside it (cloud-auth.ts and
// cloud-forget.ts), which the service worker uses. eslint.config.mjs says so. Never the store worker, the offscreen document,
// content scripts, backup, export or the test hooks.
//
// This file never logs, and no error it throws holds a value it read.

export const LOCAL_ONLY_DB = 'sop-local';
const DB_VERSION = 1;

/** The five object stores of v1. Exported so the e2e helper that seeds a secret builds the same database. */
export const LOCAL_ONLY_STORES: readonly { name: string; options?: IDBObjectStoreParameters }[] = [
  { name: 'secrets', options: { keyPath: 'name' } }, // { name: SecretName, value: string }
  { name: 'meta', options: { keyPath: 'key' } }, // { key: MetaKey, value: string }; claudeSpendMonth holds JSON { month, usd } (Phase 4, A6)
  // Phase 3: salted fingerprints of the files the owner chose "Never save this file" for, { hash, list: 'never-save' }. (The list
  // of forgotten readings is the library store's own, R89.) R105b keeps a second list here: the readings the owner said Send for in
  // "Send … to Anthropic?", { hash, list: 'claude-agreed', since } (`since` is the reading's `createdAt`).
  { name: 'never_save', options: { keyPath: 'hash' } },
  { name: 'filter_reports', options: { keyPath: 'id', autoIncrement: true } }, // Phase 3: { hash, label } from "Report a wrong decision"
  { name: 'handles' }, // out-of-line keys: folder handles
];

export type LocalOnlyObjectStore = 'secrets' | 'meta' | 'never_save' | 'filter_reports';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_ONLY_DB, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const { name, options } of LOCAL_ONLY_STORES) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, options);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('The local-only database did not open.'));
    request.onblocked = () => reject(new Error('The local-only database is blocked by another tab.'));
  });
}

export interface LocalOnlyConnection {
  /** Runs `body` in one transaction and answers when the transaction has committed. Writes wait for the disk. */
  transact: <T>(store: LocalOnlyObjectStore, mode: IDBTransactionMode, body: (objects: IDBObjectStore, answer: (value: T) => void) => void) => Promise<T>;
}

/** Opens (and, the first time, creates) the local-only database, and keeps one connection, opened again if the browser closes it. */
export async function connectLocalOnly(): Promise<LocalOnlyConnection> {
  let opening: Promise<IDBDatabase> | undefined;
  // One connection, opened again if the browser closes it (a deleted database, a newer version in another tab).
  const database = (): Promise<IDBDatabase> =>
    (opening ??= openDatabase().then(
      (db) => {
        db.onversionchange = () => {
          opening = undefined;
          db.close();
        };
        db.onclose = () => {
          opening = undefined;
        };
        return db;
      },
      (error: unknown) => {
        opening = undefined;
        throw error;
      },
    ));
  await database();

  async function transact<T>(store: LocalOnlyObjectStore, mode: IDBTransactionMode, body: (objects: IDBObjectStore, answer: (value: T) => void) => void): Promise<T> {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
      let result!: T;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('The local-only database could not be used.'));
      tx.onabort = () => reject(tx.error ?? new Error('The local-only database could not be used.'));
      body(tx.objectStore(store), (value) => {
        result = value;
      });
    });
  }
  return { transact };
}
