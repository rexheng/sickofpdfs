// The local-only store: the owner's API key, the sign-in token and the small things that must never leave this
// computer. It is its own IndexedDB database ("sop-local") in the extension's origin.
//
// WHO MAY IMPORT THIS FILE: viewer and settings code only (ESLint enforces it, see eslint.config.mjs). The store
// worker, the offscreen document, the service worker, content scripts, backup, export, sync and the test hooks must not
// reach it, so a secret can never land in the library database, a backup, an export or a message.
//
// Content scripts and web pages cannot read it either: IndexedDB belongs to an origin, and a content script runs in
// the origin of the page it is on, not the extension's.
//
// This file never logs, and no error it throws holds a secret value.

export const LOCAL_ONLY_DB = 'sop-local';
const DB_VERSION = 1;

export type SecretName = 'anthropic_api_key' | 'cloud_token';
export type MetaKey = 'filterSalt' | 'claudeSpendMonth';

const SECRET_NAMES: readonly SecretName[] = ['anthropic_api_key', 'cloud_token'];
const META_KEYS: readonly MetaKey[] = ['filterSalt', 'claudeSpendMonth'];
/** The meta keys that hold a random value made on first use (`ensureMeta`). The others are written by their own feature. */
const RANDOM_META_KEYS: readonly MetaKey[] = ['filterSalt'];

/** The five object stores of v1. Exported so the e2e helper that seeds a secret builds the same database. */
export const LOCAL_ONLY_STORES: readonly { name: string; options?: IDBObjectStoreParameters }[] = [
  { name: 'secrets', options: { keyPath: 'name' } }, // { name: SecretName, value: string }
  { name: 'meta', options: { keyPath: 'key' } }, // { key: MetaKey, value: string }; claudeSpendMonth holds JSON { month, usd } (Phase 4, A6)
  { name: 'never_save', options: { keyPath: 'hash' } }, // Phase 3: salted hashes of documents the owner chose not to save
  { name: 'filter_reports', options: { keyPath: 'id', autoIncrement: true } }, // Phase 3: "report a wrong decision" notes
  { name: 'handles' }, // out-of-line keys: folder handles
];

export interface LocalOnlyStore {
  getSecret(name: SecretName): Promise<string | null>;
  setSecret(name: SecretName, value: string): Promise<void>;
  deleteSecret(name: SecretName): Promise<void>;
  getMeta(key: MetaKey): Promise<string | null>;
  /** The stored value, or a new random 128-bit hex value that is stored first. Tabs racing here agree on one value. Only for keys that hold a random value (`filterSalt`). */
  ensureMeta(key: MetaKey): Promise<string>;
  /**
   * Reads the value, lets `change` make the new one from it, and writes that, all in ONE read-write transaction: IndexedDB runs such
   * transactions one after another, so two tabs updating at once never lose an update. Answers with the value now stored.
   * `change` runs inside the transaction: it must be quick and synchronous, and must not throw.
   */
  updateMeta(key: MetaKey, change: (current: string | null) => string): Promise<string>;
}

function randomHex128(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function assertSecretName(name: string): asserts name is SecretName {
  if (!(SECRET_NAMES as readonly string[]).includes(name)) throw new TypeError('Unknown secret name.');
}

function assertMetaKey(key: string): asserts key is MetaKey {
  if (!(META_KEYS as readonly string[]).includes(key)) throw new TypeError('Unknown meta key.');
}

function assertRandomMetaKey(key: string): void {
  if (!(RANDOM_META_KEYS as readonly string[]).includes(key)) throw new TypeError('This meta key does not hold a random value.');
}

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

/** Opens (and, the first time, creates) the local-only database. Call it from viewer or settings code only. */
export async function openLocalOnlyStore(): Promise<LocalOnlyStore> {
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

  /** Runs `body` in one transaction and answers when the transaction has committed. Writes wait for the disk. */
  async function transact<T>(store: 'secrets' | 'meta', mode: IDBTransactionMode, body: (objects: IDBObjectStore, answer: (value: T) => void) => void): Promise<T> {
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

  const readValue = (record: unknown): string | null => {
    const value = (record as { value?: unknown } | undefined)?.value;
    return typeof value === 'string' ? value : null;
  };

  return {
    async getSecret(name) {
      assertSecretName(name);
      return await transact<string | null>('secrets', 'readonly', (store, answer) => {
        const request = store.get(name);
        request.onsuccess = () => answer(readValue(request.result));
      });
    },

    async setSecret(name, value) {
      assertSecretName(name);
      if (typeof value !== 'string' || value === '') throw new TypeError('A secret must be a non-empty string. To remove one, delete it.');
      return await transact<void>('secrets', 'readwrite', (store) => {
        store.put({ name, value });
      });
    },

    async deleteSecret(name) {
      assertSecretName(name);
      return await transact<void>('secrets', 'readwrite', (store) => {
        store.delete(name);
      });
    },

    async getMeta(key) {
      assertMetaKey(key);
      return await transact<string | null>('meta', 'readonly', (store, answer) => {
        const request = store.get(key);
        request.onsuccess = () => answer(readValue(request.result));
      });
    },

    async ensureMeta(key) {
      assertMetaKey(key);
      assertRandomMetaKey(key);
      // Reading and writing in one readwrite transaction: IndexedDB runs such transactions one after another.
      return await transact<string>('meta', 'readwrite', (store, answer) => {
        const request = store.get(key);
        request.onsuccess = () => {
          const existing = readValue(request.result);
          if (existing !== null) return answer(existing);
          const created = randomHex128();
          store.put({ key, value: created });
          answer(created);
        };
      });
    },

    async updateMeta(key, change) {
      assertMetaKey(key);
      return await transact<string>('meta', 'readwrite', (store, answer) => {
        const request = store.get(key);
        request.onsuccess = () => {
          const next = change(readValue(request.result));
          store.put({ key, value: next });
          answer(next);
        };
      });
    },
  };
}
