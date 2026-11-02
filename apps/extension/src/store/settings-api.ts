// The library's synced settings (contracts §5, "Synced settings keys"): `filter.allow` and `filter.deny` for the learning
// filter's lists, and later `shortcuts.overrides`, `lookups.online` and `library.layout`. Each value is stored as JSON text
// in the `settings` table, so sync and backup carry it like any other row (sync keeps web entries of the filter lists only).
//
// Wiring (Task 28's `createStoreApi`): `StoreApi extends SettingsApi`, and the object it returns spreads
// `createSettingsApi(db, deps)`. `protocol.ts` serves `SETTINGS_API_METHODS`, and `client.ts` proxies them.
//
// Rules this file keeps:
// - A key that reads like a secret (`apiKey`, `token`, `salt` …) is refused: secrets live in `sop-local`, never here.
// - R91: `filter.allow` and `filter.deny` only take entries the filter may use. An entry that would apply to everything (a bare
//   top-level domain, `/`, a drive root, `file:///`) is refused on both, and a catch-all place (Downloads, a mail attachment,
//   a shared store) on the allow list. The filter drops such entries again when it reads the lists (an entry may come by sync).
// - Every write is one transaction, stamps `hlc`, leaves `rev` to sync, and publishes its change after it commits.
// - Errors are rejections whose message starts with a code (`bad-input: …`), so the code survives a message port.
import { type HlcStamp, type ListKind, listEntryProblem, MAX_LIST_ENTRY } from '@sop/core';
import { isSecretSettingKey } from '@sop/core/sync';
import type { StoreChange } from './change-bus';
import { isReadOnly, type SqlDb, type SqlValue } from './schema-v2';

export interface SettingsApi {
  /** The setting's value, or null when it was never set (or its stored text is not JSON). */
  getSetting(key: string): Promise<unknown>;
  /** Sets a setting to any JSON value. Setting the value it already has writes nothing. */
  setSetting(key: string, value: unknown): Promise<void>;
  /**
   * Adds `entry` to the list setting `key` (a JSON array of strings, such as `filter.allow`) unless it is there already, in
   * one transaction, so two tabs adding at once never lose an entry. Answers with the list now stored.
   */
  addToSettingList(key: string, entry: string): Promise<string[]>;
}

/** The method names `protocol.ts` serves and `client.ts` proxies. */
export const SETTINGS_API_METHODS = ['getSetting', 'setSetting', 'addToSettingList'] as const satisfies readonly (keyof SettingsApi)[];
/** The methods that only read: their answers are not kept for replays. */
export const SETTINGS_READ_METHODS = ['getSetting'] as const satisfies readonly (keyof SettingsApi)[];

/** A key is a dotted name: `filter.allow`, `library.layout`. */
const KEY = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;
const MAX_KEY = 128;
/** The longest stored value (JSON text). The lists are short; this only stops a runaway write. */
const MAX_VALUE = 64 * 1024;
/** The longest list entry: a site, a web address or a folder. */
const MAX_ENTRY = MAX_LIST_ENTRY;

/** The filter's lists (contracts §5), whose entries R91 checks. */
const FILTER_LISTS: Readonly<Record<string, ListKind>> = { 'filter.allow': 'allow', 'filter.deny': 'deny' };

/** R91: refuses an entry the filter may not use on this list, saying why in plain words. */
function checkFilterEntry(key: string, entry: unknown): void {
  const list = FILTER_LISTS[key];
  if (list === undefined) return;
  const problem = listEntryProblem(entry, list);
  if (problem !== null) throw new SettingsError('bad-input', `this can’t be on the ${list} list: ${problem}`);
}

export interface SettingsDeps {
  hlc: { tick(): HlcStamp };
  publish(c: StoreChange): void;
}

class SettingsError extends Error {
  constructor(code: 'bad-input' | 'read-only', message: string) {
    super(`${code}: ${message}`);
    this.name = 'StoreError';
  }
}

function checkKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length > MAX_KEY || !KEY.test(key)) throw new SettingsError('bad-input', 'a setting key is a dotted name');
  if (isSecretSettingKey(key)) throw new SettingsError('bad-input', 'secrets are never kept in the library');
}

function toJson(value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined;
  }
  if (text === undefined) throw new SettingsError('bad-input', 'a setting value must be plain data');
  if (text.length > MAX_VALUE) throw new SettingsError('bad-input', 'the setting value is too long');
  return text;
}

function fromJson(text: SqlValue | undefined): unknown {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Runs `f` and returns its result as a promise, so a thrown error is a rejection and never a throw at the call site. */
function attempt<T>(f: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      resolve(f());
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

export function createSettingsApi(db: SqlDb, deps: SettingsDeps): SettingsApi {
  const read = (key: string): SqlValue | undefined => db.selectValue('SELECT value FROM settings WHERE key = ?', [key]);
  const assertWritable = (): void => {
    if (isReadOnly(db)) throw new SettingsError('read-only', 'Update sickofpdfs. This library was saved by a newer version, so it cannot be changed.');
  };
  const publish = (key: string): void => {
    try {
      deps.publish({ table: 'settings', ids: [key], op: 'upsert' });
    } catch {
      // Other tabs read the setting again the next time they need it.
    }
  };
  /** Writes `text` under `key` unless it is stored already. True when it wrote. */
  const write = (key: string, text: string): boolean => {
    if (read(key) === text) return false;
    db.exec({
      sql: `INSERT INTO settings (key, value, hlc) VALUES (?, ?, ?)
            ON CONFLICT (key) DO UPDATE SET value = excluded.value, hlc = excluded.hlc`,
      bind: [key, text, deps.hlc.tick()],
    });
    return true;
  };

  return {
    getSetting: (key) =>
      attempt(() => {
        checkKey(key);
        return fromJson(read(key));
      }),

    setSetting: (key, value) =>
      attempt(() => {
        checkKey(key);
        if (FILTER_LISTS[key] !== undefined) {
          if (!Array.isArray(value)) throw new SettingsError('bad-input', 'a filter list is a list of sites and folders');
          for (const entry of value) checkFilterEntry(key, entry);
        }
        const text = toJson(value);
        assertWritable();
        if (db.savepoint(() => write(key, text))) publish(key);
      }),

    addToSettingList: (key, entry) =>
      attempt(() => {
        checkKey(key);
        if (typeof entry !== 'string' || entry.trim() === '' || entry.length > MAX_ENTRY) throw new SettingsError('bad-input', 'a list entry is a short piece of text');
        checkFilterEntry(key, entry);
        const clean = entry.trim();
        assertWritable();
        let list: string[] = [];
        const wrote = db.savepoint(() => {
          const now = fromJson(read(key));
          list = Array.isArray(now) ? now.filter((x): x is string => typeof x === 'string') : [];
          if (list.includes(clean)) return false;
          list = [...list, clean];
          return write(key, toJson(list));
        });
        if (wrote) publish(key);
        return list;
      }),
  };
}
