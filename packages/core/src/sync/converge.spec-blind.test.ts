// Spec-blind seeded property tests for CL2's mergeEntry: several computers edit, delete and restore one thread's comments
// offline and sync in random orders.
//
// Sources: spec "Sync rules" and the non-negotiable "no lost notes"; contracts §7 (records, the local side: one entry per
// queued row with the oldest queued baseRev, a row created and deleted before any push is dropped, pulled rows skip rows
// with a queued edit, `Hlc.receive` on every pulled stamp) and CA10; the plan's CL2 rules, Gate 1's unit-test line ("a
// random-order convergence check (no distinct non-empty note body ever disappears)") and the carried requirement on replay
// memory; research 05 §3.2 ("The client overwrites its local copies with the rebased rows").
//
// The devices follow the published protocol and nothing more:
// - after `apply` with no rebase, a device keeps its row and takes the new rev;
// - after `rebase`, it takes the stored row and rev;
// - after `noop` with no rebase, it is acknowledged at the stored revision and keeps its row.
// The server is the kit's FakeServer (CL4's replay memory, conflict copies created once).
//
// "No sent text disappears": every comment text a device sent as a live note is, at the end, the body of some stored
// comment (live, in a tombstone, or a conflict copy), unless a device that had that text as its synced copy replaced it
// with other text or deleted the note on purpose.
import { describe, expect, it } from 'vitest';
import {
  type Entry,
  FakeServer,
  MIN,
  type MergeResult,
  STAMP_RE,
  T0,
  THREAD,
  type Wire,
  commentRow,
  counterOf,
  msOf,
  pick,
  rng,
  shuffle,
  stamp,
  threadRow,
  uuid,
} from '../../test/spec-blind/sync-kit';

const HOUR = 60 * MIN;
const MULTI_ROUND_SEEDS = Array.from({ length: 30 }, (_, i) => 1001 + i);
const ONE_ROUND_SEEDS = Array.from({ length: 40 }, (_, i) => 2001 + i);

interface Local {
  row: Wire;
  rev: number;
  hlc: string;
  /** The body of this device's last synced copy (what it saw). */
  baseBody: string | null;
  dirty: boolean;
  /** The baseRev of the oldest queued change. */
  outboxBaseRev: number;
}

class Book {
  sentLive = new Set<string>();
  replaced = new Set<string>();
  problems: string[] = [];
  sent(e: Entry, baseBody: string | null): void {
    const b = String(e.row.body);
    if (e.row.deletedAt == null) {
      this.sentLive.add(b);
      if (baseBody !== null && baseBody !== b) this.replaced.add(baseBody);
    } else if (baseBody !== null) this.replaced.add(baseBody);
  }
}

const same = (a: Wire, b: Wire) => a.body === b.body && (a.deletedAt == null) === (b.deletedAt == null) && a.author === b.author && a.threadId === b.threadId;

class Device {
  readonly local = new Map<string, Local>();
  private lastMs = 0;
  private ctr = 0;
  private n = 0;
  constructor(
    readonly id: string,
    private readonly index: number,
    private readonly skew: number,
  ) {}

  private wall(real: number) {
    return real + this.skew;
  }
  private tick(real: number): string {
    const w = this.wall(real);
    if (w > this.lastMs) {
      this.lastMs = w;
      this.ctr = 0;
    } else this.ctr += 1;
    return stamp(this.lastMs, this.ctr, this.id);
  }
  private receive(remote: string, real: number): void {
    if (!STAMP_RE.test(remote)) return;
    const rm = msOf(remote);
    const rc = counterOf(remote);
    const m = Math.max(this.wall(real), this.lastMs, rm);
    if (m === this.lastMs && m === rm) this.ctr = Math.max(this.ctr, rc) + 1;
    else if (m === this.lastMs) this.ctr += 1;
    else if (m === rm) this.ctr = rc + 1;
    else this.ctr = 0;
    this.lastMs = m;
  }
  private touch(l: Local, real: number): void {
    if (!l.dirty) {
      l.dirty = true;
      l.outboxBaseRev = l.rev;
    }
    l.hlc = this.tick(real);
  }

  live(): string[] {
    return [...this.local].filter(([, l]) => l.row.deletedAt == null).map(([id]) => id);
  }
  trashed(): string[] {
    return [...this.local].filter(([, l]) => l.row.deletedAt != null).map(([id]) => id);
  }
  edit(id: string, real: number): void {
    const l = this.local.get(id)!;
    l.row = { ...l.row, body: `${this.id} wrote #${++this.n}`, editedAt: this.wall(real) };
    this.touch(l, real);
  }
  remove(id: string, real: number): void {
    const l = this.local.get(id)!;
    l.row = { ...l.row, deletedAt: this.wall(real) };
    this.touch(l, real);
  }
  restore(id: string, real: number): void {
    const l = this.local.get(id)!;
    l.row = { ...l.row, deletedAt: null };
    this.touch(l, real);
  }
  create(real: number): void {
    const n = ++this.n;
    const id = uuid(this.index * 100_000 + n, 'cf');
    const l: Local = { row: commentRow({ id, body: `${this.id} new #${n}`, createdAt: this.wall(real) }), rev: 0, hlc: '', baseBody: null, dirty: false, outboxBaseRev: 0 };
    this.local.set(id, l);
    this.touch(l, real);
  }

  /** One entry per queued row: the current row, with the oldest queued baseRev. */
  outbox(): { entry: Entry; baseBody: string | null }[] {
    const out: { entry: Entry; baseBody: string | null }[] = [];
    for (const [id, l] of this.local) {
      if (!l.dirty) continue;
      if (l.rev === 0 && l.row.deletedAt != null) {
        this.local.delete(id); // created and deleted before it was ever pushed: dropped
        continue;
      }
      out.push({ entry: { table: 'comments', id, baseRev: l.outboxBaseRev, hlc: l.hlc, row: structuredClone(l.row) }, baseBody: l.baseBody });
    }
    return out;
  }

  push(server: FakeServer, real: number, book: Book): void {
    for (const { entry: e, baseBody } of this.outbox()) {
      book.sent(e, baseBody);
      this.settle(e, server.push(this.id, e, real), server, book, real);
    }
  }

  private settle(e: Entry, r: MergeResult, server: FakeServer, book: Book, real: number): void {
    const l = this.local.get(e.id)!;
    l.dirty = false;
    if (r.kind === 'reject') {
      book.problems.push(`${this.id} ${e.id}: refused ${r.code} (${r.message})`);
      return;
    }
    const s = server.get('comments', e.id);
    if (!s) {
      book.problems.push(`${this.id} ${e.id}: ${r.kind} but the server holds no row`);
      return;
    }
    if (r.kind === 'apply' && !r.rebase) {
      if (!same(r.row, e.row)) book.problems.push(`${this.id} ${e.id}: applied a different row without asking the device to rebase`);
      l.rev = r.rev;
    } else if (r.rebase) {
      l.row = structuredClone(s.row);
      l.rev = s.rev;
    } else l.rev = s.rev;
    l.baseBody = String(l.row.body);
    this.receive(s.hlc, real);
  }

  pull(server: FakeServer, real: number): void {
    for (const s of server.all('comments')) {
      if (this.local.get(s.id)?.dirty) continue; // a pulled row skips a row with a queued edit
      this.local.set(s.id, { row: structuredClone(s.row), rev: s.rev, hlc: s.hlc, baseBody: String(s.row.body), dirty: false, outboxBaseRev: s.rev });
      this.receive(s.hlc, real);
    }
  }
}

const view = (rows: Iterable<[string, Wire]>) =>
  [...rows].map(([id, r]) => `${id} | ${String(r.body)} | ${r.deletedAt == null ? 'live' : 'deleted'} | ${String(r.threadId)}`).sort();

function lostTexts(server: FakeServer, book: Book): string[] {
  const kept = new Set(server.all('comments').map((s) => String(s.row.body)));
  return [...book.sentLive].filter((t) => !kept.has(t) && !book.replaced.has(t)).sort();
}

function freshServer(): FakeServer {
  return new FakeServer().seedDocument().seed('threads', THREAD, 1, stamp(T0, 0, 'dev0'), 'dev0', threadRow());
}

// ---------------------------------------------------------------------------------------------------------------

describe('many rounds: random offline edits, deletes and restores, pushed and pulled in random orders', () => {
  it.each(MULTI_ROUND_SEEDS)('seed %i: every computer converges, no sent text disappears, and replaying the whole log changes nothing', (seed) => {
    const r = rng(seed);
    const server = freshServer();
    const book = new Book();
    const count = 2 + Math.floor(r() * 3);
    // One seed in four has a computer whose clock is an hour fast; the others are within ±200 s.
    const devices = Array.from({ length: count }, (_, i) => new Device(`dev${i}`, i, i === 0 && seed % 4 === 0 ? HOUR : Math.round((r() - 0.5) * 400_000)));
    let real = T0 + MIN;
    devices[0].create(real);
    devices[0].push(server, real, book);
    for (const d of devices) d.pull(server, real);

    for (let step = 0; step < 160; step++) {
      real += 1_000 + Math.floor(r() * 120_000);
      const d = pick(r, devices);
      const x = r();
      if (x < 0.3) {
        const ids = d.live();
        if (ids.length) d.edit(pick(r, ids), real);
      } else if (x < 0.4) {
        const ids = d.live();
        if (ids.length) d.remove(pick(r, ids), real);
      } else if (x < 0.48) {
        const ids = d.trashed();
        if (ids.length) d.restore(pick(r, ids), real);
      } else if (x < 0.56) d.create(real);
      else if (x < 0.8) d.push(server, real, book);
      else d.pull(server, real);
    }
    for (const d of shuffle(r, devices)) {
      real += 1_000;
      d.push(server, real, book);
    }
    for (const d of devices) d.pull(server, real);

    expect(book.problems, `seed ${seed}`).toEqual([]);

    const want = view(server.all('comments').map((s) => [s.id, s.row]));
    for (const d of devices) {
      expect([...d.local.values()].filter((l) => l.dirty), `seed ${seed}: ${d.id} still has queued rows`).toEqual([]);
      expect(view([...d.local].map(([id, l]) => [id, l.row])), `seed ${seed}: ${d.id} matches the server`).toEqual(want);
    }

    expect(lostTexts(server, book), `seed ${seed}: sent text that vanished`).toEqual([]);

    const before = server.snapshot();
    const log = server.log.filter((p) => p.result.kind !== 'reject');
    for (const [label, order] of [['in order', log], ['shuffled', shuffle(r, log)]] as const) {
      const bad: string[] = [];
      for (const p of order) {
        const res = server.push(p.device, p.entry, real);
        if (res.kind !== 'noop' || res.why !== 'replay' || res.conflictCopy) bad.push(`${p.device} ${p.entry.id} ${p.entry.hlc}: ${JSON.stringify(res)}`);
      }
      expect(bad, `seed ${seed}: replay ${label}`).toEqual([]);
      expect(server.snapshot(), `seed ${seed}: replay ${label} left the server as it was`).toBe(before);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('one round from a common start: the push order never changes the outcome', () => {
  it.each(ONE_ROUND_SEEDS)('seed %i: every order gives the same notes and the same conflict copies, and no sent text disappears', (seed) => {
    const r = rng(seed);
    const start = freshServer();
    for (let i = 0; i < 3; i++) {
      const id = uuid(100 + i);
      const trashed = i === 2;
      start.seed('comments', id, trashed ? 2 : 1, stamp(T0 + i, 0, 'dev0'), 'dev0', commentRow({ id, body: `start text ${i}`, deletedAt: trashed ? T0 + 1_000 : null }));
    }
    const count = 2 + Math.floor(r() * 3);
    const devices = Array.from({ length: count }, (_, i) => new Device(`dev${i}`, i, Math.round((r() - 0.5) * 400_000)));
    let real = T0 + HOUR;
    for (const d of devices) d.pull(start, real);

    for (const d of devices) {
      const ops = 1 + Math.floor(r() * 3);
      for (let k = 0; k < ops; k++) {
        real += 1_000 + Math.floor(r() * 60_000);
        const x = r();
        const live = d.live();
        const trashed = d.trashed();
        if (x < 0.45 && live.length) d.edit(pick(r, live), real);
        else if (x < 0.7 && live.length) d.remove(pick(r, live), real);
        else if (x < 0.85 && trashed.length) d.restore(pick(r, trashed), real);
        else d.create(real);
      }
    }
    const queued = devices.flatMap((d) => d.outbox().map((q) => ({ device: d.id, ...q })));
    const book = new Book();
    for (const q of queued) book.sent(q.entry, q.baseBody);

    const end = T0 + 3 * HOUR;
    const outcomes: string[][] = [];
    for (let p = 0; p < 6; p++) {
      const s = start.fork();
      for (const q of p === 0 ? queued : shuffle(r, queued)) {
        const res = s.push(q.device, structuredClone(q.entry), end);
        if (res.kind === 'reject') book.problems.push(`${q.device} ${q.entry.id}: refused ${res.code}`);
      }
      expect(lostTexts(s, book), `seed ${seed}, order ${p}: sent text that vanished`).toEqual([]);
      outcomes.push(
        s
          .all('comments')
          .map((c) => {
            const meta = c.row.meta as Wire | undefined;
            const who = meta?.kind === 'conflict-copy' ? `copy of ${String(meta.of)}` : c.id;
            return `${who} | ${String(c.row.body)} | ${c.row.deletedAt == null ? 'live' : 'deleted'}`;
          })
          .sort(),
      );
    }
    expect(book.problems, `seed ${seed}`).toEqual([]);
    for (let p = 1; p < outcomes.length; p++) expect(outcomes[p], `seed ${seed}: order ${p} against order 0`).toEqual(outcomes[0]);
  });
});
