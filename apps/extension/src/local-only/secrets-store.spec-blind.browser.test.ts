// Spec-blind browser test for Task 29: the local-only (secrets) store.
//
// Sources (interface file, Task 29):
//   LOCAL_ONLY_DB = 'sop-local'; SecretName 'anthropic_api_key' | 'cloud_token'; MetaKey 'filterSalt'; LocalOnlyStore { getSecret, setSecret,
//     deleteSecret, getMeta, ensureMeta ("random 128-bit hex when missing") }; "IndexedDB 'sop-local' v1: secrets, meta, never_save,
//     filter_reports, handles"; "plain indexedDB.open('sop-local', 1) whose onupgradeneeded creates the five stores"; "never goes into
//     backups or the library database".
//   spec, Privacy and Storage: "Your API key sits in the extension's private database, which content scripts and web pages cannot read";
//     backups "never include your API key, sign-in tokens, the never-save list"; "secrets live in a separate store that backups, export and
//     sync cannot read"; "choosing 'Never save this file' keeps a salted fingerprint on this computer only".
// Real Chromium, real IndexedDB. Each tab is a worker: a separate copy of the module and a separate connection, as in the product.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type Fn = 'getSecret' | 'setSecret' | 'deleteSecret' | 'getMeta' | 'ensureMeta';
const workers: Worker[] = [];
let nextId = 1;

function newTab(): (fn: Fn, ...args: unknown[]) => Promise<unknown> {
  const worker = new Worker(new URL('./secrets-store.spec-blind.worker.ts', import.meta.url), { type: 'module' });
  workers.push(worker);
  let broken: Error | undefined; // the worker could not even start (for example its import failed): every call fails at once
  const listeners = new Set<(e: Error) => void>();
  worker.addEventListener('error', (e) => {
    broken = new Error(e.message || 'the secrets store worker failed to start');
    for (const l of listeners) l(broken);
  });
  return (fn, ...args) =>
    new Promise((resolve, reject) => {
      if (broken) return reject(broken);
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`the secrets store did not answer ${fn}`)), 20_000);
      const onBroken = (e: Error) => {
        clearTimeout(timer);
        reject(e);
      };
      listeners.add(onBroken);
      const listener = (e: MessageEvent<{ id: number; ok: boolean; value?: unknown; error?: string }>) => {
        if (e.data.id !== id) return;
        worker.removeEventListener('message', listener);
        listeners.delete(onBroken);
        clearTimeout(timer);
        if (e.data.ok) resolve(e.data.value);
        else reject(new Error(e.data.error));
      };
      worker.addEventListener('message', listener);
      worker.postMessage({ id, fn, args });
    });
}

/** Stops every tab, then removes the database: the state of a fresh install. */
async function freshInstall(): Promise<void> {
  for (const w of workers.splice(0)) w.terminate();
  await new Promise((r) => setTimeout(r, 200));
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('sop-local');
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => setTimeout(resolve, 2000);
  });
}

beforeEach(freshInstall);
afterEach(freshInstall);

/** Every record of every object store of an IndexedDB database, as one JSON text. Opens without a version, so it never changes the database. */
async function dumpDatabase(name: string): Promise<string> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(`cannot open ${name}`));
  });
  try {
    const out: Record<string, unknown> = {};
    for (const storeName of db.objectStoreNames) {
      out[storeName] = await new Promise((resolve, reject) => {
        const store = db.transaction(storeName).objectStore(storeName);
        const keys = store.getAllKeys();
        const values = store.getAll();
        values.onsuccess = () => resolve({ keys: keys.result, values: values.result });
        values.onerror = () => reject(new Error(`cannot read ${storeName}`));
      });
    }
    return JSON.stringify(out, (_k: string, v: unknown): unknown => (v instanceof ArrayBuffer ? Array.from(new Uint8Array(v)) : v instanceof Blob ? `blob:${v.size}` : v));
  } finally {
    db.close();
  }
}

/** Every place in this origin where a string could have been put, except the secrets database itself. Returns what mentions `needle`. */
async function whereIsIt(needle: string): Promise<string[]> {
  const found: string[] = [];
  const root = await navigator.storage.getDirectory();
  const walk = async (dir: FileSystemDirectoryHandle, path: string): Promise<void> => {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') await walk(handle, `${path}${name}/`);
      else {
        let bytes = new ArrayBuffer(0);
        try {
          bytes = await (await (handle).getFile()).arrayBuffer();
        } catch {
          // a file another page holds locked cannot be read; it is somebody else's database file
        }
        if (new TextDecoder('latin1').decode(bytes).includes(needle)) found.push(`opfs:${path}${name}`);
      }
    }
  };
  await walk(root, '');
  for (const db of await indexedDB.databases()) {
    if (db.name && db.name !== 'sop-local' && (await dumpDatabase(db.name).catch(() => '')).includes(needle)) found.push(`indexeddb:${db.name}`);
  }
  if (JSON.stringify({ ...localStorage }).includes(needle)) found.push('localStorage');
  if (JSON.stringify({ ...sessionStorage }).includes(needle)) found.push('sessionStorage');
  if (document.cookie.includes(needle)) found.push('cookie');
  for (const cacheName of await caches.keys()) {
    const cache = await caches.open(cacheName);
    for (const req of await cache.keys()) if (req.url.includes(needle) || (await (await cache.match(req))?.text())?.includes(needle)) found.push(`cache:${cacheName}`);
  }
  return found;
}

describe('secrets', () => {
  // plain ASCII, so a stray copy would show up when other storage is searched as bytes
  // Built at run time, so no key-shaped literal is ever committed (not even a fake one).
  const KEY = ['sk', 'ant', 'api03', 'SPECBLIND-0123456789abcdefghijklmnopqrstuvwxyz_-ABCDEFGHIJKLMNOPQRSTUVWXYZ'].join('-');
  const SECOND_KEY = ['sk', 'ant', 'second'].join('-');
  const REPLACEMENT_KEY = ['sk', 'ant', 'replacement', 'value'].join('-');
  const TOKEN_ASCII = 'cloud-token-9f8e7d6c5b4a';
  const TOKEN = `${TOKEN_ASCII}-Zürich-✓-日本語`;

  it('are kept, replaced and deleted one by one, and are the same in every tab and after every tab has been closed', async () => {
    const a = newTab();
    expect(await a('getSecret', 'anthropic_api_key')).toBeNull();
    expect(await a('getSecret', 'cloud_token')).toBeNull();

    await a('setSecret', 'anthropic_api_key', KEY);
    await a('setSecret', 'cloud_token', TOKEN);
    const b = newTab();
    expect(await b('getSecret', 'anthropic_api_key')).toBe(KEY);
    expect(await b('getSecret', 'cloud_token'), 'exactly as typed, accents and symbols included').toBe(TOKEN);

    await b('setSecret', 'anthropic_api_key', SECOND_KEY);
    expect(await a('getSecret', 'anthropic_api_key'), 'the latest value wins in the other tab too').toBe(SECOND_KEY);

    await a('deleteSecret', 'cloud_token');
    expect(await b('getSecret', 'cloud_token')).toBeNull();
    expect(await b('getSecret', 'anthropic_api_key'), 'deleting one secret leaves the other').toBe(SECOND_KEY);
    await expect(a('deleteSecret', 'cloud_token'), 'deleting what is not there is harmless').resolves.toBeNull();

    for (const w of workers.splice(0)) w.terminate(); // every tab closed
    expect(await newTab()('getSecret', 'anthropic_api_key'), 'it survives a restart').toBe(SECOND_KEY);
  });

  it('live in the database "sop-local" version 1 with its five stores, and nowhere else in the browser\'s storage for this site', async () => {
    const a = newTab();
    await a('setSecret', 'anthropic_api_key', KEY);
    await a('setSecret', 'cloud_token', TOKEN);

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('sop-local');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('no sop-local'));
    });
    try {
      expect(db.version).toBe(1);
      expect([...db.objectStoreNames].sort()).toEqual(['filter_reports', 'handles', 'meta', 'never_save', 'secrets']);
    } finally {
      db.close();
    }
    const everything = await dumpDatabase('sop-local');
    expect(everything, 'the control: the dump sees the key').toContain(KEY.slice(0, 40));

    for (const secret of [KEY, KEY.slice(0, 40), TOKEN_ASCII]) expect(await whereIsIt(secret), `"${secret.slice(0, 20)}..." was found outside the secrets database`).toEqual([]);
  });

  it('deleting a secret leaves no copy of it in the secrets database (no old value, no log)', async () => {
    const a = newTab();
    await a('setSecret', 'anthropic_api_key', KEY);
    await a('setSecret', 'anthropic_api_key', REPLACEMENT_KEY);
    expect(await dumpDatabase('sop-local')).not.toContain(KEY.slice(0, 40));

    await a('deleteSecret', 'anthropic_api_key');
    expect(await dumpDatabase('sop-local')).not.toContain(REPLACEMENT_KEY);
  });
});

describe('the filter salt (meta)', () => {
  it('is missing until it is first asked for; then it is 128 random bits in hex, made once even when many tabs ask at the same moment, and kept', async () => {
    const first = newTab();
    expect(await first('getMeta', 'filterSalt')).toBeNull();

    const tabs = Array.from({ length: 6 }, () => newTab());
    const salts = await Promise.all(tabs.map((tab) => tab('ensureMeta', 'filterSalt')));

    expect(new Set(salts).size, 'every tab got the same salt').toBe(1);
    expect(salts[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(await first('getMeta', 'filterSalt')).toBe(salts[0]);
    expect(await first('ensureMeta', 'filterSalt'), 'asking again does not make a new one').toBe(salts[0]);

    for (const w of workers.splice(0)) w.terminate();
    expect(await newTab()('getMeta', 'filterSalt'), 'it survives a restart').toBe(salts[0]);
  });
});
