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

/** The owner's label in "Report a wrong decision": what the PDF really is. */
export type FilterReportLabel = 'learning' | 'not-learning';

const SECRET_NAMES: readonly SecretName[] = ['anthropic_api_key', 'cloud_token'];
const META_KEYS: readonly MetaKey[] = ['filterSalt', 'claudeSpendMonth'];
/** The meta keys that hold a random value made on first use (`ensureMeta`). The others are written by their own feature. */
const RANDOM_META_KEYS: readonly MetaKey[] = ['filterSalt'];

/** The five object stores of v1. Exported so the e2e helper that seeds a secret builds the same database. */
export const LOCAL_ONLY_STORES: readonly { name: string; options?: IDBObjectStoreParameters }[] = [
  { name: 'secrets', options: { keyPath: 'name' } }, // { name: SecretName, value: string }
  { name: 'meta', options: { keyPath: 'key' } }, // { key: MetaKey, value: string }; claudeSpendMonth holds JSON { month, usd } (Phase 4, A6)
  // Phase 3: salted fingerprints, { hash, list }. `list` is 'never-save' (the owner chose "Never save this file") or 'forgotten'
  // (forgotten on this computer, so a restore never brings it back). The two lists hash differently, so they never collide.
  { name: 'never_save', options: { keyPath: 'hash' } },
  { name: 'filter_reports', options: { keyPath: 'id', autoIncrement: true } }, // Phase 3: { hash, label } from "Report a wrong decision"
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
  /** Writes the value of a meta key that its own feature keeps (`claudeSpendMonth`). Never the salt: it is made once. */
  setMeta(key: MetaKey, value: string): Promise<void>;

  // Phase 3, the learning filter (contracts §5). Each takes a file's fingerprint (its SHA-256, 64 lower-case hex) and keeps only
  // an HMAC of it keyed by `filterSalt`, never the fingerprint, the file or anything read from it. Reads never create the salt.
  /** "Never save this file": true when the owner chose it for these bytes. */
  isNeverSave(sha: string): Promise<boolean>;
  addNeverSave(sha: string): Promise<void>;
  /** The owner saved these bytes after all: their latest choice wins. */
  removeNeverSave(sha: string): Promise<void>;
  /** "Report a wrong decision": the owner's label and the salted fingerprint, nothing else. A second report of a file replaces the first. */
  addFilterReport(sha: string, label: FilterReportLabel): Promise<void>;
  /** Forgotten on this computer (ruling R75): a restore skips these, even from a backup the forget could not clean. */
  isForgotten(sha: string): Promise<boolean>;
  addForgotten(sha: string): Promise<void>;
  /** Saved again after it was forgotten: a restore may bring it back. */
  removeForgotten(sha: string): Promise<void>;
}

type FingerprintList = 'never-save' | 'forgotten';
const REPORT_LABELS: readonly FilterReportLabel[] = ['learning', 'not-learning'];
const FINGERPRINT = /^[0-9a-f]{64}$/;

function assertFingerprint(sha: unknown): asserts sha is string {
  // The message never repeats what it was given.
  if (typeof sha !== 'string' || !FINGERPRINT.test(sha)) throw new TypeError('A fingerprint is 64 lower-case hex characters.');
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** HMAC-SHA-256 of "<list>:<fingerprint>" keyed by the salt, as hex. The list name keeps the lists apart. */
async function saltedHash(salt: string, list: FingerprintList | 'report', sha: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', hexToBytes(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${list}:${sha}`));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
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
  async function transact<T>(store: 'secrets' | 'meta' | 'never_save' | 'filter_reports', mode: IDBTransactionMode, body: (objects: IDBObjectStore, answer: (value: T) => void) => void): Promise<T> {
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

  const api: LocalOnlyStore = {
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

    async setMeta(key, value) {
      assertMetaKey(key);
      if ((RANDOM_META_KEYS as readonly string[]).includes(key)) throw new TypeError('This meta key holds a random value made once; it cannot be set.');
      if (typeof value !== 'string') throw new TypeError('A meta value is a string.');
      return await transact<void>('meta', 'readwrite', (store) => {
        store.put({ key, value });
      });
    },

    isNeverSave: (sha) => onList('never-save', sha),
    addNeverSave: (sha) => addToList('never-save', sha),
    removeNeverSave: (sha) => removeFromList('never-save', sha),
    isForgotten: (sha) => onList('forgotten', sha),
    addForgotten: (sha) => addToList('forgotten', sha),
    removeForgotten: (sha) => removeFromList('forgotten', sha),

    async addFilterReport(sha, label) {
      assertFingerprint(sha);
      if (!REPORT_LABELS.includes(label)) throw new TypeError('A report label is "learning" or "not-learning".');
      const hash = await saltedHash(await salt(true), 'report', sha);
      return await transact<void>('filter_reports', 'readwrite', (store) => {
        // One report per file: an earlier one is replaced, in the same transaction.
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (c === null) {
            store.add({ hash, label });
            return;
          }
          if ((c.value as { hash?: unknown }).hash === hash) c.delete();
          c.continue();
        };
      });
    },
  };

  /** The filter salt. A read never makes one: no salt means no list holds anything yet. */
  async function salt(create: true): Promise<string>;
  async function salt(create: false): Promise<string | null>;
  async function salt(create: boolean): Promise<string | null> {
    if (create) return api.ensureMeta('filterSalt');
    return api.getMeta('filterSalt');
  }

  async function onList(list: FingerprintList, sha: string): Promise<boolean> {
    assertFingerprint(sha);
    const s = await salt(false);
    if (s === null) return false;
    const hash = await saltedHash(s, list, sha);
    return await transact<boolean>('never_save', 'readonly', (objects, answer) => {
      const request = objects.get(hash);
      request.onsuccess = () => answer((request.result as { list?: unknown } | undefined)?.list === list);
    });
  }

  async function addToList(list: FingerprintList, sha: string): Promise<void> {
    assertFingerprint(sha);
    const hash = await saltedHash(await salt(true), list, sha);
    return await transact<void>('never_save', 'readwrite', (objects) => {
      objects.put({ hash, list });
    });
  }

  async function removeFromList(list: FingerprintList, sha: string): Promise<void> {
    assertFingerprint(sha);
    const s = await salt(false);
    if (s === null) return;
    const hash = await saltedHash(s, list, sha);
    return await transact<void>('never_save', 'readwrite', (objects) => {
      objects.delete(hash);
    });
  }

  return api;
}
