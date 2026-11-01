// This month's Claude spend, kept on this computer in the local-only store (`sop-local`, meta key `claudeSpendMonth`, contract
// addition A6): JSON `{ "month": "YYYY-MM", "usd": 1.23 }`. Viewer and Settings code only; the store worker, backups and sync never
// import it.
//
// The database is opened only through `openLocalOnlyStore()` (Task 29), which owns its creation and upgrades. This file never
// opens IndexedDB itself, so a fresh profile works with no setup and the layout has one owner.
//
// `addSpend` is one read-write transaction (`updateMeta`: get, add, put). Transactions on the same store run one after the other,
// even from two tabs, so two tabs adding at once never lose an update. When the local month changes, the total starts again
// from zero. The amounts come from the real `usage` of each reply (cost.ts), not from estimates.
import { openLocalOnlyStore, type LocalOnlyStore } from '../../local-only/secrets-store';

export interface SpendRecord { month: string; usd: number }

/** The local month, "2026-11". Local time, because "this month" is the owner's month. */
export function monthOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Where the record lives. Both calls answer for the one stored record. */
export interface SpendStorage {
  read(): Promise<SpendRecord | null>;
  /** One transaction: reads the stored record, lets `change` make the new one from it, writes it, and answers with it. */
  update(change: (current: SpendRecord | null) => SpendRecord): Promise<SpendRecord>;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function parseRecord(raw: string | null): SpendRecord | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const { month, usd } = value as { month?: unknown; usd?: unknown };
  if (typeof month !== 'string' || !MONTH.test(month) || typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return null;
  return { month, usd };
}

/** The real storage: the local-only store's meta record. The store is opened on first use, and opened again if that failed. */
export function localStoreSpendStorage(open: () => Promise<LocalOnlyStore> = openLocalOnlyStore): SpendStorage {
  let opening: Promise<LocalOnlyStore> | undefined;
  const store = (): Promise<LocalOnlyStore> =>
    (opening ??= open().catch((error: unknown) => {
      opening = undefined;
      throw error;
    }));
  return {
    async read() {
      return parseRecord(await (await store()).getMeta('claudeSpendMonth'));
    },
    async update(change) {
      let result!: SpendRecord;
      await (await store()).updateMeta('claudeSpendMonth', (current) => {
        result = change(parseRecord(current));
        return JSON.stringify(result);
      });
      return result;
    },
  };
}

export interface Spend {
  /** Adds the real cost of a reply to this month's total and returns the new total. Rejects a negative or non-finite amount and changes nothing. */
  addSpend(usd: number): Promise<SpendRecord>;
  /** This month's total so far (zero when nothing was spent, or when the stored month is an earlier one). */
  thisMonth(): Promise<SpendRecord>;
}

/** Whole nano-dollars, so many small additions never drift. */
const round9 = (n: number) => Math.round(n * 1e9) / 1e9;

export function createSpend(o: { storage?: SpendStorage; now?: () => Date } = {}): Spend {
  const storage = o.storage ?? localStoreSpendStorage();
  const now = o.now ?? (() => new Date());
  return {
    addSpend(usd) {
      if (!Number.isFinite(usd) || usd < 0) return Promise.reject(new RangeError('A cost must be a number that is not negative.'));
      const month = monthOf(now());
      return storage.update((current) => ({ month, usd: round9((current && current.month === month ? current.usd : 0) + usd) }));
    },
    async thisMonth() {
      const month = monthOf(now());
      const current = await storage.read();
      return { month, usd: current && current.month === month ? current.usd : 0 };
    },
  };
}

let shared: Spend | undefined;
const sharedSpend = () => (shared ??= createSpend());

/** This tab's way to record a reply's cost. */
export const addSpend = (usd: number): Promise<SpendRecord> => sharedSpend().addSpend(usd);
/** This month's total, for Settings and for the cap check. */
export const getSpend = (): Promise<SpendRecord> => sharedSpend().thisMonth();
