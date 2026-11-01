/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- these tests read wire JSON from an API we do not own, and cast modules that did not exist when they were written */
// Spec-blind browser tests for slice H, part 2: the month's spend (apps/extension/src/viewer/claude/spend.ts) on a real IndexedDB.
//
// Sources:
//   plan Phase 4, slice H: "`addSpend(usd)`: one IndexedDB transaction on `claudeSpendMonth`, reset when the local month
//     changes"; "Spec-blind table tests: price maths, cap boundaries, month rollover, and two tabs adding spend at once";
//   plan A6: `claudeSpendMonth` in `sop-local` holds JSON `{ month: 'YYYY-MM'; usd: number }`;
//   plan done-when 3 and risks: the cap uses real `usage`, so a lost or poisoned total would let the cap be passed.
//
// The spend is read straight out of IndexedDB ("sop-local"), not through spend.ts, because the interface names only `addSpend`.
// The reader looks through every object store for a record holding `{ month, usd }`, so it does not depend on how the local-only
// store lays its records out. Each test uses its own far-future year, so tests do not need to wipe the database: the first spend
// of a new month resets the old total, which is the behaviour under test.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addSpend } from './spend';

type Stored = { month: string; usd: number };
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };
const asSpend = (v: unknown): Stored | null => {
  if (v && typeof v === 'object' && typeof (v as Stored).month === 'string' && MONTH.test((v as Stored).month) && 'usd' in (v as object)) return v as Stored;
  return null;
};
function findSpend(row: unknown): Stored | null {
  if (typeof row === 'string') return asSpend(parse(row));
  const direct = asSpend(row);
  if (direct) return direct;
  if (row && typeof row === 'object') {
    for (const v of Object.values(row)) {
      const hit = typeof v === 'string' ? asSpend(parse(v)) : asSpend(v);
      if (hit) return hit;
    }
  }
  return null;
}

/** What "sop-local" holds for the month's spend, or null. Never creates the database. */
async function readSpend(): Promise<Stored | null> {
  if (!(await indexedDB.databases()).some((d) => d.name === 'sop-local')) return null;
  const db = await new Promise<IDBDatabase>((ok, fail) => {
    const r = indexedDB.open('sop-local');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error ?? new Error('indexedDB.open failed'));
  });
  try {
    for (const name of Array.from(db.objectStoreNames)) {
      const rows = await new Promise<unknown[]>((ok, fail) => {
        const q = db.transaction(name, 'readonly').objectStore(name).getAll();
        q.onsuccess = () => ok(q.result);
        q.onerror = () => fail(q.error ?? new Error('getAll failed'));
      });
      for (const row of rows) {
        const hit = findSpend(row);
        if (hit) return hit;
      }
    }
    return null;
  } finally {
    db.close();
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
const localMonth = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const at = (y: number, month1: number, day: number, h = 12, min = 0, s = 0) => new Date(y, month1 - 1, day, h, min, s); // LOCAL time, as "the local month" means

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const clock = (d: Date) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(d); };

describe('the month total accumulates and rolls over with the local month (slice H, A6)', () => {
  it('adds up many small spends without rounding them away (a Haiku answer is a fraction of a cent)', async () => {
    clock(at(2041, 3, 15));
    for (let i = 0; i < 10; i++) await addSpend(0.0007);
    const s = await readSpend();
    expect(s).not.toBeNull();
    expect(s!.month).toBe('2041-03');
    expect(s!.usd).toBeCloseTo(0.007, 6);
  });

  it('is stored as exactly { month, usd } (contract A6)', async () => {
    clock(at(2041, 4, 2));
    await addSpend(0.25);
    const s = (await readSpend())!;
    expect(Object.keys(s).sort()).toEqual(['month', 'usd']);
    expect(typeof s.usd).toBe('number');
    expect(s.month).toMatch(MONTH);
  });

  it.each<{ name: string; steps: [Date, number][]; want: Stored }>([
    { name: 'a new month starts again from zero', steps: [[at(2042, 1, 31, 23, 59), 3.5], [at(2042, 2, 1, 0, 1), 0.02]], want: { month: '2042-02', usd: 0.02 } },
    { name: 'the end of December rolls into the next year', steps: [[at(2043, 12, 31, 23, 59, 59), 1], [at(2044, 1, 1, 0, 0, 1), 0.5]], want: { month: '2044-01', usd: 0.5 } },
    { name: 'the first and the last minute of one month are the same month', steps: [[at(2045, 3, 1, 0, 0), 0.1], [at(2045, 3, 31, 23, 59), 0.2]], want: { month: '2045-03', usd: 0.3 } },
    { name: 'the month is the LOCAL month (built from local clock parts)', steps: [[at(2046, 6, 30, 23, 30), 0.4], [at(2046, 6, 30, 23, 45), 0.1]], want: { month: localMonth(at(2046, 6, 30, 23, 30)), usd: 0.5 } },
    { name: 'skipping a whole month still starts from zero', steps: [[at(2047, 1, 10), 9], [at(2047, 4, 10), 0.01]], want: { month: '2047-04', usd: 0.01 } },
  ])('$name', async ({ steps, want }) => {
    for (const [when, usd] of steps) {
      clock(when);
      await addSpend(usd);
    }
    const s = (await readSpend())!;
    expect(s.month).toBe(want.month);
    expect(s.usd).toBeCloseTo(want.usd, 9);
  });
});

/** A clock for a place `hoursWest` hours behind UTC, standing still at `instant`. Only the local-time parts move, as in a real zone. */
function stubZone(hoursWest: number, instant: number): void {
  const Real = Date;
  const shifted = (d: Date) => new Real(d.getTime() - hoursWest * 3_600_000);
  class Zoned extends Real {
    constructor(...args: unknown[]) { super(...((args.length === 0 ? [instant] : args) as [number])); }
    static override now(): number { return instant; }
    override getFullYear(): number { return shifted(this).getUTCFullYear(); }
    override getMonth(): number { return shifted(this).getUTCMonth(); }
    override getDate(): number { return shifted(this).getUTCDate(); }
    override getDay(): number { return shifted(this).getUTCDay(); }
    override getHours(): number { return shifted(this).getUTCHours(); }
    override getTimezoneOffset(): number { return hoursWest * 60; }
  }
  vi.stubGlobal('Date', Zoned);
}

describe('the month is the LOCAL month even where local and UTC disagree (spec: "reset when the local month changes")', () => {
  it('at 03:00 UTC on 1 March, eight hours west of UTC it is still February', async () => {
    stubZone(8, Date.UTC(2052, 2, 1, 3, 0)); // local: 29 February 2052, 19:00
    await addSpend(1);
    expect((await readSpend())!.month).toBe('2052-02');
    stubZone(8, Date.UTC(2052, 2, 1, 9, 0)); // local: 1 March, 01:00: a new month at last
    await addSpend(0.05);
    const s = (await readSpend())!;
    expect(s.month).toBe('2052-03');
    expect(s.usd).toBeCloseTo(0.05, 9);
  });

  it('and eight hours east of UTC the new month starts before UTC gets there', async () => {
    stubZone(-8, Date.UTC(2053, 4, 31, 17, 0)); // local: 1 June 2053, 01:00; UTC is still 31 May
    await addSpend(0.1);
    expect((await readSpend())!.month).toBe('2053-06');
  });
});

describe('spend that arrives at the same moment is never lost (one transaction per spend)', () => {
  it('40 spends started together in one tab all count', async () => {
    clock(at(2048, 4, 10));
    await Promise.all(Array.from({ length: 40 }, () => addSpend(0.01)));
    expect((await readSpend())!.usd).toBeCloseTo(0.4, 9);
  });

  it('two tabs adding at once: nothing is lost', async () => {
    vi.useRealTimers(); // the second tab has its own clock, so both use the real one
    const month = localMonth(new Date());
    const before = await readSpend();
    const baseline = before && before.month === month ? before.usd : 0;

    const worker = new Worker(new URL('./spend-peer.spec-blind.worker.ts', import.meta.url), { type: 'module' });
    try {
      const wait = (kind: 'ready' | 'done') => new Promise<void>((ok, fail) => {
        const timer = setTimeout(() => fail(new Error(`the second tab never said ${kind}`)), 20_000);
        const onMessage = (e: MessageEvent<{ type: string; message?: string }>) => {
          if (e.data.type === 'failed') { clearTimeout(timer); fail(new Error(e.data.message)); }
          if (e.data.type === kind) { clearTimeout(timer); worker.removeEventListener('message', onMessage); ok(); }
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', (e) => { clearTimeout(timer); fail(new Error(e.message)); });
      });
      await wait('ready');
      const done = wait('done');
      worker.postMessage({ type: 'go', count: 30, amount: 0.01 });
      await Promise.all([done, ...Array.from({ length: 30 }, () => addSpend(0.01))]);
      const s = (await readSpend())!;
      expect(s.month).toBe(month);
      expect(s.usd).toBeCloseTo(baseline + 0.6, 9);
    } finally {
      worker.terminate();
    }
  });
});

describe('spend that is not a sensible amount cannot poison the total or lower it (a NaN would switch the cap off)', () => {
  // each case gets its own year, so one case's total is never the next case's starting point
  it.each([Number.NaN, -0.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].map((bad, i) => ({ bad, year: 2050 + i })))('addSpend($bad) changes nothing', async ({ bad, year }) => {
    clock(at(year, 2, 2));
    await addSpend(0.5);
    await Promise.resolve().then(() => addSpend(bad)).catch(() => undefined); // refusing loudly or ignoring quietly are both fine
    const s = (await readSpend())!;
    expect(Number.isFinite(s.usd)).toBe(true);
    expect(s.usd).toBeCloseTo(0.5, 9);
    await addSpend(0.25);
    expect((await readSpend())!.usd).toBeCloseTo(0.75, 9); // and it still works afterwards
  });
});
