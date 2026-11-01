// This month's Claude spend, kept on this computer in `sop-local` under `claudeSpendMonth` (contract addition A6):
// JSON `{ "month": "YYYY-MM", "usd": 1.23 }`. Viewer and Settings code only; the store worker, backups and sync never import it.
//
// `addSpend` is one IndexedDB read-write transaction (get, add, put). Transactions on the same store run one after the other,
// even from two tabs, so two tabs adding at once never lose an update. When the local month changes, the total starts again
// from zero. The amounts come from the real `usage` of each reply (cost.ts), not from estimates.
//
// This file does not create the `sop-local` database. The secrets store (Task 29) owns its layout, and the key is saved before the
// first question can be asked, so by the time anything is spent the database exists. If it does not, `addSpend` fails with a
// plain error instead of creating a database of the wrong shape.

export interface SpendRecord { month: string; usd: number }

/** The key inside `sop-local`'s `meta` store. */
export const SPEND_KEY = 'claudeSpendMonth';
const DB_NAME = 'sop-local';
const STORE = 'meta';

export class SpendUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpendUnavailableError';
  }
}

/** The local month, "2026-11". Local time, because "this month" is the owner's month. */
export function monthOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Reads the current record (or null), lets `fn` decide the new one, and writes it, all in one atomic step. */
export interface SpendStorage {
  transact<T>(fn: (current: SpendRecord | null) => { next: SpendRecord | null; result: T }): Promise<T>;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function parseRecord(raw: unknown): SpendRecord | null {
  let value: unknown = raw;
  if (value !== null && typeof value === 'object' && 'value' in value) value = (value).value;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== 'object') return null;
  const { month, usd } = value as { month?: unknown; usd?: unknown };
  if (typeof month !== 'string' || !MONTH.test(month) || typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return null;
  return { month, usd };
}

function openLocalDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onupgradeneeded = () => {
      // The database did not exist: opening it created an empty one. Undo that, so the secrets store can make it properly.
      req.transaction?.abort();
    };
    req.onerror = () => reject(new SpendUnavailableError("Claude's spending record is not available yet. Save your Claude key in Settings first."));
    req.onsuccess = () => resolve(req.result);
  });
}

/** The real storage: one read-write transaction on `sop-local`/`meta`. */
export function idbSpendStorage(): SpendStorage {
  return {
    async transact(fn) {
      const db = await openLocalDb();
      try {
        if (!db.objectStoreNames.contains(STORE)) throw new SpendUnavailableError("Claude's spending record is not available yet. Save your Claude key in Settings first.");
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          const store = tx.objectStore(STORE);
          let result!: ReturnType<typeof fn>['result'];
          tx.oncomplete = () => resolve(result);
          tx.onerror = () => reject(tx.error ?? new Error('The spending record could not be saved.'));
          tx.onabort = () => reject(tx.error ?? new Error('The spending record could not be saved.'));
          const read = store.get(SPEND_KEY);
          read.onsuccess = () => {
            const out = fn(parseRecord(read.result));
            result = out.result;
            if (out.next === null) return;
            const json = JSON.stringify(out.next);
            // Task 29's meta store may key its records in the record (a keyPath) or beside it; follow whichever it is.
            if (typeof store.keyPath === 'string') store.put({ [store.keyPath]: SPEND_KEY, value: json });
            else store.put(json, SPEND_KEY);
          };
        });
      } finally {
        db.close();
      }
    },
  };
}

export interface Spend {
  /** Adds the real cost of a reply to this month's total and returns the new total. Throws for a negative or non-finite amount. */
  addSpend(usd: number): Promise<SpendRecord>;
  /** This month's total so far (zero when nothing was spent, or when the stored month is an earlier one). */
  thisMonth(): Promise<SpendRecord>;
}

/** Whole nano-dollars, so many small additions never drift. */
const round9 = (n: number) => Math.round(n * 1e9) / 1e9;

export function createSpend(o: { storage?: SpendStorage; now?: () => Date } = {}): Spend {
  const storage = o.storage ?? idbSpendStorage();
  const now = o.now ?? (() => new Date());
  return {
    addSpend(usd) {
      if (!Number.isFinite(usd) || usd < 0) return Promise.reject(new RangeError('A cost must be a number that is not negative.'));
      const month = monthOf(now());
      return storage.transact((current) => {
        const next: SpendRecord = { month, usd: round9((current && current.month === month ? current.usd : 0) + usd) };
        return { next, result: next };
      });
    },
    thisMonth() {
      const month = monthOf(now());
      return storage.transact((current) => ({ next: null, result: { month, usd: current && current.month === month ? current.usd : 0 } }));
    },
  };
}

let shared: Spend | undefined;
const sharedSpend = () => (shared ??= createSpend());

/** This tab's way to record a reply's cost. */
export const addSpend = (usd: number): Promise<SpendRecord> => sharedSpend().addSpend(usd);
/** This month's total, for Settings and for the cap check. */
export const getSpend = (): Promise<SpendRecord> => sharedSpend().thisMonth();
