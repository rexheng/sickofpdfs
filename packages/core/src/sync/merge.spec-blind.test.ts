// Spec-blind table tests for CL2's mergeEntry: what wins when two computers (or Claude) change the same row.
//
// Sources: spec "Sync rules (Release 2)" ("the later change wins, and the other version of a note's text is added to its
// thread as a reply marked 'edited on another device'"; "An edit beats a delete"; "Note drafts stay local"); contracts §7
// (records, server rules, what never syncs) and CA10; the Phase 5–6 plan's CL2 rules (a retry is a no-op; history and
// locations merge per field; the smaller document id wins an alias; `author` never changes; the `claude` device writes only
// `claude` rows) and its carried requirements (R57, replay memory); research 05 §3.2 and §3.4.
//
// How the tests read a result: a FakeServer (test/spec-blind/sync-kit.ts) stores an `apply` row with the result's rev and
// hlc, creates a conflict copy if its id is new, and answers `processedUpTo` and `documentState` the way CL4 must. The
// assertions are about what the server holds afterwards, so the code may build its results any way it likes.
import { describe, expect, it } from 'vitest';
import {
  type Apply,
  type Entry,
  FakeServer,
  type MergeCtx,
  MIN,
  NOW,
  type Noop,
  type Reject,
  SKEW_DEFAULT,
  STAMP_RE,
  T0,
  THREAD,
  type Wire,
  DOC,
  aliasRow,
  bitset,
  bytesOf,
  claudeMeta,
  commentRow,
  documentRow,
  entry,
  hex64,
  historyRow,
  locationRow,
  markRow,
  mergeEntry,
  msOf,
  orBytes,
  stamp,
  threadRow,
  uuid,
} from '../../test/spec-blind/sync-kit';

const A = 'devA';
const B = 'devB';
const CLAUDE = 'claude';
const C1 = uuid(1);
const M1 = uuid(1, 'aa');
const BASE = 'Parallel trends look fine before 2008.';
const TAB = '5d9b2c1e-0000-4000-8000-00000000ab01';

/** A learning document with one thread and one sent owner comment (rev 1), as both devices last saw it. */
function base(o: ConstructorParameters<typeof FakeServer>[0] = {}): FakeServer {
  return new FakeServer(o)
    .seedDocument()
    .seed('threads', THREAD, 1, stamp(T0, 0, A), A, threadRow())
    .seed('comments', C1, 1, stamp(T0, 1, A), A, commentRow({ id: C1, body: BASE }))
    .seed('marks', M1, 1, stamp(T0, 2, A), A, markRow({ id: M1 }));
}

const comment = (body: string, o: Wire = {}) => commentRow({ id: C1, body, ...o });
const body = (s: FakeServer, id = C1) => s.get('comments', id)?.row.body;
const isDeleted = (s: FakeServer, table: 'comments' | 'marks', id: string) => s.get(table, id)?.row.deletedAt != null;
const copyBodies = (s: FakeServer) => s.copies().map((c) => c.row.body);
const rebased = (r: Apply | Noop) => Boolean(r.rebase);

function expectRejected(r: ReturnType<typeof mergeEntry>, retryable?: boolean): asserts r is Reject {
  expect(r.kind).toBe('reject');
  const j = r as Reject;
  expect(typeof j.code).toBe('string');
  expect(j.code.length).toBeGreaterThan(0);
  if (retryable !== undefined) expect(j.retryable).toBe(retryable);
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

// ---------------------------------------------------------------------------------------------------------------

describe('the fast path', () => {
  it('stores a new comment as sent, at rev 1, with no conflict copy and nothing to rebase', () => {
    const s = new FakeServer().seedDocument().seed('threads', THREAD, 1, stamp(T0, 0, A), A, threadRow());
    const h = stamp(T0 + MIN, 0, A);
    const r = s.push(A, entry('comments', C1, 0, h, comment(BASE)));
    expect(r.kind).toBe('apply');
    const a = r as Apply;
    expect(a.rev).toBe(1);
    expect(a.hlc).toBe(h);
    expect(a.row).toMatchObject({ id: C1, threadId: THREAD, documentId: DOC, author: 'me', body: BASE, deletedAt: null });
    expect(a.conflictCopy).toBeNull();
    expect(rebased(a)).toBe(false);
  });

  it('stores an edit based on the current revision and bumps the revision by one', () => {
    const s = base();
    const r = s.push(A, entry('comments', C1, 1, stamp(T0 + 5 * MIN, 0, A), comment('Edited once.', { editedAt: T0 + 5 * MIN })));
    expect(r).toMatchObject({ kind: 'apply', rev: 2, conflictCopy: null });
    expect(body(s)).toBe('Edited once.');
  });

  it('is pure: it changes neither the server row nor the entry it is given', () => {
    const server = deepFreeze({ table: 'comments' as const, id: C1, rev: 2, hlc: stamp(T0 + 9 * MIN, 0, B), device: B, row: comment('B wrote this.') });
    const e = deepFreeze(entry('comments', C1, 1, stamp(T0 + 8 * MIN, 0, A), comment('A wrote this.')));
    const ctx: MergeCtx = { device: A, now: NOW, documentState: () => 'known', processedUpTo: () => null };
    const before = JSON.stringify([server, e]);
    expect(() => mergeEntry(server, e, ctx)).not.toThrow();
    expect(JSON.stringify([server, e])).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('two devices edit one comment offline', () => {
  const OLDER = 'Trends hold before 2008, but only for the treated firms.';
  const NEWER = 'Trends break in 2006. See Figure 3.';
  const eOld = (): Entry => entry('comments', C1, 1, stamp(T0 + 10 * MIN, 0, A), comment(OLDER, { editedAt: T0 + 10 * MIN }));
  const eNew = (): Entry => entry('comments', C1, 1, stamp(T0 + 20 * MIN, 0, B), comment(NEWER, { editedAt: T0 + 20 * MIN }));

  it.each([
    { order: 'the older edit is pushed first', olderFirst: true },
    { order: 'the newer edit is pushed first', olderFirst: false },
  ])('$order: the later edit wins and exactly one conflict copy keeps the other text', ({ olderFirst }) => {
    const s = base();
    const r1 = olderFirst ? s.push(A, eOld()) : s.push(B, eNew());
    const r2 = olderFirst ? s.push(B, eNew()) : s.push(A, eOld());

    expect(r1).toMatchObject({ kind: 'apply', conflictCopy: null });
    expect(s.get('comments', C1)?.row).toMatchObject({ body: NEWER, deletedAt: null, author: 'me' });

    const copies = s.copies();
    expect(copies).toHaveLength(1);
    expect(copies[0].id).not.toBe(C1);
    expect(copies[0].row).toMatchObject({
      body: OLDER, threadId: THREAD, documentId: DOC, author: 'me', deletedAt: null, draftOfTab: null,
      meta: { kind: 'conflict-copy', v: 1, of: C1, device: A },
    });

    expect(r2.kind).toBe(olderFirst ? 'apply' : 'noop');
    const second = r2 as Apply | Noop;
    // The device whose edit lost must take the winning row (it shows the newer text and the copy after the round trip).
    if (!olderFirst) expect(rebased(second)).toBe(true);
    expect(second.conflictCopy).toMatchObject({ table: 'comments', rev: 1, of: C1, createOnly: true });
    expect(second.conflictCopy?.hlc).toMatch(STAMP_RE);
  });

  it('makes no copy when both devices typed the same text', () => {
    const s = base();
    s.push(A, entry('comments', C1, 1, stamp(T0 + 10 * MIN, 0, A), comment('Same words.')));
    s.push(B, entry('comments', C1, 1, stamp(T0 + 20 * MIN, 0, B), comment('Same words.')));
    expect(body(s)).toBe('Same words.');
    expect(s.copies()).toHaveLength(0);
  });

  // "the newer hlc wins": time first, then the hex counter, then the device (Task 28's compareHlc, carried requirement)
  it.each([
    { name: 'the time decides before the counter', win: stamp(T0 + 61_000, 0, 'devA'), lose: stamp(T0 + 60_000, 0xffff, 'devZ') },
    { name: 'the hex counter decides before the device (0x000a > 0x0002)', win: stamp(T0 + 60_000, 0x000a, 'devA'), lose: stamp(T0 + 60_000, 0x0002, 'devB') },
    { name: 'the device decides a tie of time and counter', win: stamp(T0 + 60_000, 5, 'devB'), lose: stamp(T0 + 60_000, 5, 'devA') },
  ])('$name, in either push order', ({ win, lose }) => {
    for (const winnerFirst of [true, false]) {
      const s = base();
      const w = entry('comments', C1, 1, win, comment('winner'));
      const l = entry('comments', C1, 1, lose, comment('loser'));
      const dw = win.slice(19);
      const dl = lose.slice(19);
      if (winnerFirst) {
        s.push(dw, w);
        s.push(dl, l);
      } else {
        s.push(dl, l);
        s.push(dw, w);
      }
      expect(body(s), `winner pushed ${winnerFirst ? 'first' : 'second'}`).toBe('winner');
      expect(copyBodies(s)).toEqual(['loser']);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('an edit beats a delete (spec), in every order', () => {
  const EDIT = 'Parallel trends fail: the 2006 dip is real.';
  const cases = [false, true].flatMap((deleteNewer) =>
    [true, false].map((deleteFirst) => ({ name: `the delete is ${deleteNewer ? 'newer' : 'older'} and pushed ${deleteFirst ? 'first' : 'second'}`, deleteNewer, deleteFirst })),
  );

  it.each(cases)('comment: $name → the note comes back with the edit, and no copy is made', ({ deleteNewer, deleteFirst }) => {
    const s = base();
    const tDel = T0 + (deleteNewer ? 30 : 10) * MIN;
    const tEdit = T0 + (deleteNewer ? 10 : 30) * MIN;
    const del = entry('comments', C1, 1, stamp(tDel, 0, A), comment(BASE, { deletedAt: tDel }));
    const edit = entry('comments', C1, 1, stamp(tEdit, 0, B), comment(EDIT, { editedAt: tEdit }));
    const r1 = deleteFirst ? s.push(A, del) : s.push(B, edit);
    const r2 = deleteFirst ? s.push(B, edit) : s.push(A, del);
    expect(r1.kind).toBe('apply');
    expect(s.get('comments', C1)?.row).toMatchObject({ body: EDIT, deletedAt: null });
    expect(s.copies()).toHaveLength(0);
    if (!deleteFirst) {
      // The deleting device must get the note back.
      expect(r2.kind).toBe('noop');
      expect(rebased(r2 as Noop)).toBe(true);
    }
  });

  it.each(cases.filter((c) => c.deleteNewer))('mark: $name → the mark comes back with the edit', ({ deleteFirst }) => {
    const s = base();
    const del = entry('marks', M1, 1, stamp(T0 + 30 * MIN, 0, A), markRow({ id: M1, deletedAt: T0 + 30 * MIN }));
    const edit = entry('marks', M1, 1, stamp(T0 + 10 * MIN, 0, B), markRow({ id: M1, color: 3, updatedAt: T0 + 10 * MIN }));
    if (deleteFirst) {
      s.push(A, del);
      s.push(B, edit);
    } else {
      s.push(B, edit);
      s.push(A, del);
    }
    expect(s.get('marks', M1)?.row).toMatchObject({ color: 3, deletedAt: null });
  });

  it('a delete made after seeing the edit is not concurrent: it applies, and the tombstone keeps the text', () => {
    const s = base();
    s.push(B, entry('comments', C1, 1, stamp(T0 + 10 * MIN, 0, B), comment(EDIT)));
    const r = s.push(A, entry('comments', C1, 2, stamp(T0 + 20 * MIN, 0, A), comment(EDIT, { deletedAt: T0 + 20 * MIN })));
    expect(r).toMatchObject({ kind: 'apply', rev: 3, conflictCopy: null });
    expect(s.get('comments', C1)?.row).toMatchObject({ body: EDIT });
    expect(isDeleted(s, 'comments', C1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('other tables', () => {
  it.each([true, false])('marks are last-writer-wins on the whole row, with no copy (newer pushed first: %s)', (newerFirst) => {
    const s = base();
    const older = entry('marks', M1, 1, stamp(T0 + 10 * MIN, 0, A), markRow({ id: M1, color: 2 }));
    const newer = entry('marks', M1, 1, stamp(T0 + 20 * MIN, 0, B), markRow({ id: M1, color: 4 }));
    if (newerFirst) {
      s.push(B, newer);
      s.push(A, older);
    } else {
      s.push(A, older);
      s.push(B, newer);
    }
    expect(s.get('marks', M1)?.row.color).toBe(4);
    expect(s.all('comments')).toHaveLength(1);
  });

  it.each([true, false])('history merges per field: first opened min, last opened max, counters max, pages union, position from the newer stamp (A first: %s)', (aFirst) => {
    const s = base();
    // Both computers opened the paper offline, so each made its own history row (baseRev 0).
    const hA = historyRow(DOC, { firstOpened: T0 + 1_000, lastOpened: T0 + 50 * MIN, openCount: 3, readingMs: 600_000, lastPosition: { page: 2, offset: 0.5, zoom: 1 }, pagesVisited: bitset([0, 1, 2]) });
    const hB = historyRow(DOC, { firstOpened: T0 + 500, lastOpened: T0 + 40 * MIN, openCount: 5, readingMs: 300_000, lastPosition: { page: 7, offset: 0.25, zoom: 1.25 }, pagesVisited: bitset([0, 9, 10]) });
    const eA = entry('history', DOC, 0, stamp(T0 + 50 * MIN, 0, A), hA);
    const eB = entry('history', DOC, 0, stamp(T0 + 55 * MIN, 0, B), hB); // B's row was written last
    s.push(aFirst ? A : B, aFirst ? eA : eB);
    const r2 = aFirst ? s.push(B, eB) : s.push(A, eA);
    const h = s.get('history', DOC)?.row;
    expect(h).toMatchObject({ documentId: DOC, firstOpened: T0 + 500, lastOpened: T0 + 50 * MIN, openCount: 5, readingMs: 600_000, lastPosition: { page: 7, offset: 0.25, zoom: 1.25 } });
    expect(bytesOf(h?.pagesVisited)).toEqual(orBytes(bitset([0, 1, 2]), bitset([0, 9, 10])));
    expect(r2.kind).not.toBe('reject');
    expect(rebased(r2 as Apply | Noop)).toBe(true);
  });

  it.each([true, false])('locations merge: first seen min, last seen max (A first: %s)', (aFirst) => {
    const s = base();
    const L1 = hex64('10');
    const eA = entry('locations', L1, 0, stamp(T0 + 90 * MIN, 0, A), locationRow({ id: L1, firstSeen: T0 + 1_000, lastSeen: T0 + 90 * MIN }));
    const eB = entry('locations', L1, 0, stamp(T0 + 95 * MIN, 0, B), locationRow({ id: L1, firstSeen: T0 + 500, lastSeen: T0 + 30 * MIN }));
    if (aFirst) {
      s.push(A, eA);
      s.push(B, eB);
    } else {
      s.push(B, eB);
      s.push(A, eA);
    }
    expect(s.get('locations', L1)?.row).toMatchObject({ documentId: DOC, firstSeen: T0 + 500, lastSeen: T0 + 90 * MIN });
  });

  it.each([true, false])('two aliases for one fingerprint: the smaller document id wins, even against a newer stamp (larger first: %s)', (largerFirst) => {
    const SMALL = hex64('0a');
    const LARGE = hex64('f0');
    const X = hex64('e1');
    const s = base().seedDocument(SMALL).seedDocument(LARGE);
    const toLarge = entry('aliases', X, 0, stamp(T0 + 20 * MIN, 0, A), aliasRow(X, LARGE));
    const toSmall = entry('aliases', X, 0, stamp(T0 + 10 * MIN, 0, B), aliasRow(X, SMALL));
    if (largerFirst) {
      s.push(A, toLarge);
      s.push(B, toSmall);
    } else {
      s.push(B, toSmall);
      s.push(A, toLarge);
    }
    expect(s.get('aliases', X)?.row.documentId).toBe(SMALL);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('replays (a retry, or a log sent twice) change nothing', () => {
  const EDIT_A = 'A: the placebo test passes.';
  const eA = () => entry('comments', C1, 1, stamp(T0 + 10 * MIN, 0, A), comment(EDIT_A, { editedAt: T0 + 10 * MIN }));

  it('a retry of a push that was already applied is a no-op, not a conflict, even with no replay memory', () => {
    const s = base({ replayMemory: false });
    expect(s.push(A, eA()).kind).toBe('apply');
    const before = s.snapshot();
    const r = s.push(A, eA());
    expect(r).toMatchObject({ kind: 'noop', why: 'replay', conflictCopy: null });
    expect(s.snapshot()).toBe(before);
  });

  it('a replay after another device made a newer edit adds no copy, keeps the newer text, and tells the device to rebase', () => {
    const s = base();
    s.push(A, eA());
    s.push(B, entry('comments', C1, 2, stamp(T0 + 20 * MIN, 0, B), comment('B: no, it fails in 2006.')));
    const before = s.snapshot();
    const r = s.push(A, eA());
    expect(r).toMatchObject({ kind: 'noop', why: 'replay', conflictCopy: null });
    expect(s.snapshot()).toBe(before);
    // The server row is not what A replayed. Acknowledging A at the stored revision without the row would let A's next
    // edit overwrite B's text with no conflict, so A must take the stored row.
    expect(rebased(r as Noop)).toBe(true);
  });

  it('a replay after another device deleted the note does not bring it back', () => {
    const s = base();
    s.push(A, eA());
    s.push(B, entry('comments', C1, 2, stamp(T0 + 20 * MIN, 0, B), comment(EDIT_A, { deletedAt: T0 + 20 * MIN })));
    const before = s.snapshot();
    const r = s.push(A, eA());
    expect(r).toMatchObject({ kind: 'noop', why: 'replay' });
    expect(isDeleted(s, 'comments', C1)).toBe(true);
    expect(s.snapshot()).toBe(before);
  });

  const P = stamp(T0 + 30 * MIN, 5, A);
  it.each([
    { name: 'equal to processedUpTo is a replay', hlc: P, replay: true },
    { name: 'below processedUpTo is a replay', hlc: stamp(T0 + 30 * MIN, 4, A), replay: true },
    { name: 'an older entry of the same row (its creation) is a replay', hlc: stamp(T0 - MIN, 0, A), replay: true, baseRev: 0 },
    { name: 'above processedUpTo is processed as new', hlc: stamp(T0 + 30 * MIN, 6, A), replay: false },
  ])('an entry with a stamp $name', ({ hlc, replay, baseRev }) => {
    const server = { table: 'comments' as const, id: C1, rev: 3, hlc: stamp(T0 + 40 * MIN, 0, B), device: B, row: comment('B: stored text.') };
    const ctx: MergeCtx = { device: A, now: NOW, documentState: () => 'known', processedUpTo: (t, id) => (t === 'comments' && id === C1 ? P : null) };
    const r = mergeEntry(structuredClone(server), entry('comments', C1, baseRev ?? 3, hlc, comment('A: new text.')), ctx);
    if (replay) expect(r).toMatchObject({ kind: 'noop', why: 'replay', conflictCopy: null });
    else expect(r).toMatchObject({ kind: 'apply', row: { body: 'A: new text.' } });
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("Claude's rows (R57, contracts §7 server rules, plan CL2)", () => {
  const CC = uuid(9, 'cc');
  const V1 = 'Claude: the event-study plot supports parallel trends (p. 4).';
  const V2 = 'Claude: on a second read, the 2006 pre-trend is significant (p. 4, Table 2).';
  const MC = uuid(9, 'ab');
  const claudeComment = (b: string, o: Wire = {}) => commentRow({ id: CC, body: b, author: 'claude', meta: claudeMeta(), ...o });
  const withClaude = () =>
    base()
      .seed('comments', CC, 1, stamp(T0, 3, CLAUDE), CLAUDE, claudeComment(V1))
      .seed('marks', MC, 1, stamp(T0, 4, CLAUDE), CLAUDE, markRow({ id: MC, author: 'claude' }));

  it('the owner may delete a Claude comment, and the tombstone keeps its text', () => {
    const s = withClaude();
    const r = s.push(A, entry('comments', CC, 1, stamp(T0 + 5 * MIN, 0, A), claudeComment(V1, { deletedAt: T0 + 5 * MIN })));
    expect(r.kind).toBe('apply');
    expect(s.get('comments', CC)?.row).toMatchObject({ body: V1, author: 'claude' });
    expect(isDeleted(s, 'comments', CC)).toBe(true);
  });

  it('the owner may restore a Claude comment', () => {
    const s = withClaude().seed('comments', CC, 2, stamp(T0 + 5 * MIN, 0, A), A, claudeComment(V1, { deletedAt: T0 + 5 * MIN }));
    const r = s.push(A, entry('comments', CC, 2, stamp(T0 + 6 * MIN, 0, A), claudeComment(V1)));
    expect(r.kind).toBe('apply');
    expect(s.get('comments', CC)?.row).toMatchObject({ body: V1, author: 'claude', deletedAt: null });
  });

  it.each([
    { name: "rewrite a Claude comment's text", e: () => entry('comments', CC, 1, stamp(T0 + 5 * MIN, 0, A), claudeComment('My own words now.', { editedAt: T0 + 5 * MIN })) },
    { name: 'recolour a Claude mark', e: () => entry('marks', MC, 1, stamp(T0 + 5 * MIN, 0, A), markRow({ id: MC, author: 'claude', color: 3 })) },
  ])('the owner may not $name: refused for good, and nothing changes', ({ e }) => {
    const s = withClaude();
    const before = s.snapshot();
    expectRejected(s.push(A, e()), false);
    expect(s.snapshot()).toBe(before);
  });

  it('the owner may delete a Claude mark', () => {
    const s = withClaude();
    expect(s.push(A, entry('marks', MC, 1, stamp(T0 + 5 * MIN, 0, A), markRow({ id: MC, author: 'claude', deletedAt: T0 + 5 * MIN }))).kind).toBe('apply');
    expect(isDeleted(s, 'marks', MC)).toBe(true);
  });

  const r57 = [false, true].flatMap((deleteNewer) =>
    [true, false].map((ownerFirst) => ({ name: `the delete is ${deleteNewer ? 'newer' : 'older'} and pushed ${ownerFirst ? 'first' : 'second'}`, deleteNewer, ownerFirst })),
  );
  it.each(r57)(
    "the owner's delete beats a concurrent Claude edit, and Claude's text stays in the tombstone ($name); a restore brings it back",
    ({ deleteNewer, ownerFirst }) => {
      const s = withClaude();
      const tDel = T0 + (deleteNewer ? 30 : 10) * MIN;
      const tEdit = T0 + (deleteNewer ? 10 : 30) * MIN;
      const del = entry('comments', CC, 1, stamp(tDel, 0, A), claudeComment(V1, { deletedAt: tDel }));
      const edit = entry('comments', CC, 1, stamp(tEdit, 0, CLAUDE), claudeComment(V2, { editedAt: tEdit }));
      if (ownerFirst) {
        s.push(A, del);
        s.push(CLAUDE, edit);
      } else {
        s.push(CLAUDE, edit);
        s.push(A, del);
      }

      const stored = s.get('comments', CC);
      expect(stored?.row).toMatchObject({ body: V2, author: 'claude' });
      expect(isDeleted(s, 'comments', CC)).toBe(true);
      expect(s.copies()).toHaveLength(0);

      // The owner's computer takes the stored tombstone, then presses Restore in Trash.
      const r = s.push(A, entry('comments', CC, stored!.rev, stamp(T0 + 60 * MIN, 0, A), { ...stored!.row, deletedAt: null }));
      expect(r.kind).toBe('apply');
      expect(s.get('comments', CC)?.row).toMatchObject({ body: V2, author: 'claude', deletedAt: null });
    },
  );

  it.each([
    { name: 'adds its own comment', ok: true, e: () => entry('comments', uuid(10, 'cc'), 0, stamp(T0 + 5 * MIN, 0, CLAUDE), commentRow({ id: uuid(10, 'cc'), body: 'Claude: see p. 6.', author: 'claude', meta: claudeMeta() })) },
    { name: 'edits its own comment', ok: true, e: () => entry('comments', CC, 1, stamp(T0 + 5 * MIN, 0, CLAUDE), claudeComment(V2, { editedAt: T0 + 5 * MIN })) },
    { name: "adds a comment that claims to be the owner's", ok: false, e: () => entry('comments', uuid(11, 'cc'), 0, stamp(T0 + 5 * MIN, 0, CLAUDE), commentRow({ id: uuid(11, 'cc'), body: 'Owner: I agree.', author: 'me' })) },
    { name: "edits the owner's comment", ok: false, e: () => entry('comments', C1, 1, stamp(T0 + 5 * MIN, 0, CLAUDE), comment('Rewritten by Claude.')) },
    { name: "edits the owner's comment and claims it as its own", ok: false, e: () => entry('comments', C1, 1, stamp(T0 + 5 * MIN, 0, CLAUDE), comment('Rewritten by Claude.', { author: 'claude', meta: claudeMeta() })) },
    { name: "deletes the owner's comment", ok: false, e: () => entry('comments', C1, 1, stamp(T0 + 5 * MIN, 0, CLAUDE), comment(BASE, { deletedAt: T0 + 5 * MIN })) },
    { name: "recolours the owner's mark", ok: false, e: () => entry('marks', M1, 1, stamp(T0 + 5 * MIN, 0, CLAUDE), markRow({ id: M1, color: 5 })) },
  ])('the claude device $name', ({ ok, e }) => {
    const s = withClaude();
    const before = s.snapshot();
    const r = s.push(CLAUDE, e());
    if (ok) expect(r.kind).toBe('apply');
    else {
      expectRejected(r, false);
      expect(s.snapshot()).toBe(before);
    }
  });

  it.each([
    { name: "the owner's comment, pushed as Claude's", id: C1, row: () => comment(BASE, { author: 'claude' }), author: 'me' },
    { name: "Claude's comment, pushed as the owner's", id: CC, row: () => claudeComment(V1, { author: 'me', meta: {} }), author: 'claude' },
  ])('author never changes: $name keeps its author', ({ id, row, author }) => {
    const s = withClaude();
    s.push(A, entry('comments', id, 1, stamp(T0 + 5 * MIN, 0, A), row()));
    expect(s.get('comments', id)?.row.author).toBe(author);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('what the server refuses', () => {
  it.each([
    { name: 'a new draft comment', e: () => entry('comments', uuid(20), 0, stamp(T0 + MIN, 0, A), commentRow({ id: uuid(20), body: 'half a thought', draftOfTab: TAB })) },
    { name: 'a new draft thread', e: () => entry('threads', uuid(21, '7b'), 0, stamp(T0 + MIN, 0, A), threadRow({ id: uuid(21, '7b'), draftOfTab: TAB })) },
    { name: 'a sent comment pushed back as a draft', e: () => entry('comments', C1, 1, stamp(T0 + MIN, 0, A), comment('typing…', { draftOfTab: TAB })) },
  ])('drafts never sync: $name is refused for good and nothing is stored', ({ e }) => {
    const s = base();
    const before = s.snapshot();
    expectRejected(s.push(A, e()), false);
    expect(s.snapshot()).toBe(before);
  });

  const NEW_DOC = hex64('b7');
  it.each([
    { name: 'a new document labelled learning is stored', label: 'learning', ok: true },
    { name: 'a new document with no label is refused', label: undefined, ok: false },
    { name: 'a new document with another label is refused', label: 'receipt', ok: false },
  ])('$name', ({ label, ok }) => {
    const s = new FakeServer();
    const r = s.push(A, entry('documents', NEW_DOC, 0, stamp(T0 + MIN, 0, A), documentRow(NEW_DOC), label === undefined ? {} : { label }));
    if (ok) {
      expect(r.kind).toBe('apply');
      expect(s.get('documents', NEW_DOC)).not.toBeNull();
    } else {
      expectRejected(r, false);
      expect(s.get('documents', NEW_DOC)).toBeNull();
    }
  });

  it('an update of a known document without the learning label is refused too', () => {
    const s = base();
    const before = s.snapshot();
    expectRejected(s.push(A, entry('documents', DOC, 1, stamp(T0 + MIN, 0, A), documentRow(DOC, { starred: true }))), false);
    expect(s.snapshot()).toBe(before);
  });

  const STRANGER = hex64('ee');
  it.each([
    { table: 'comments' as const, e: () => entry('comments', uuid(30), 0, stamp(T0 + MIN, 0, A), commentRow({ id: uuid(30), body: 'note', documentId: STRANGER })) },
    { table: 'marks' as const, e: () => entry('marks', uuid(31, 'aa'), 0, stamp(T0 + MIN, 0, A), markRow({ id: uuid(31, 'aa'), documentId: STRANGER })) },
    { table: 'threads' as const, e: () => entry('threads', uuid(32, '7b'), 0, stamp(T0 + MIN, 0, A), threadRow({ id: uuid(32, '7b'), documentId: STRANGER })) },
    { table: 'locations' as const, e: () => entry('locations', hex64('11'), 0, stamp(T0 + MIN, 0, A), locationRow({ id: hex64('11'), documentId: STRANGER })) },
    { table: 'history' as const, e: () => entry('history', STRANGER, 0, stamp(T0 + MIN, 0, A), historyRow(STRANGER)) },
  ])('a $table row of a document the server does not know is refused, and may be retried', ({ e }) => {
    const s = base();
    const before = s.snapshot();
    expectRejected(s.push(A, e()), true);
    expect(s.snapshot()).toBe(before);
  });

  it.each([
    { name: 'a comment', e: () => entry('comments', uuid(40), 0, stamp(T0 + MIN, 0, A), commentRow({ id: uuid(40), body: 'from a computer that has not heard of the Forget' })) },
    { name: 'a location', e: () => entry('locations', hex64('12'), 0, stamp(T0 + MIN, 0, A), locationRow({ id: hex64('12') })) },
  ])('$name of a forgotten document is never stored', ({ e }) => {
    const s = base();
    s.forgotten.add(DOC);
    const before = s.snapshot();
    const r = s.push(A, e());
    expect(r.kind).not.toBe('apply');
    expect(s.snapshot()).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('a clock that is far ahead (contracts §7: the server clamps stamps more than 5 minutes ahead)', () => {
  it('is clamped when stored, so a later honest edit still wins and the fast text is kept as a copy', () => {
    const s = base();
    const FAST = 'Written on a laptop whose clock is an hour fast.';
    const HONEST = 'Written ten minutes later on a computer with the right time.';
    // At real time T0 the fast laptop stamps T0 + 1 h. The server's clock says T0.
    const r1 = s.push('devFast', entry('comments', C1, 1, stamp(T0 + 60 * MIN, 0, 'devFast'), comment(FAST)), T0);
    expect(r1.kind).toBe('apply');
    expect(msOf((r1 as Apply).hlc)).toBeLessThanOrEqual(T0 + SKEW_DEFAULT);
    expect(msOf(s.get('comments', C1)!.hlc)).toBeLessThanOrEqual(T0 + SKEW_DEFAULT);
    // Ten minutes later, a computer that had not synced since rev 1 edits the same comment.
    s.push(B, entry('comments', C1, 1, stamp(T0 + 10 * MIN, 0, B), comment(HONEST)), T0 + 10 * MIN);
    expect(body(s)).toBe(HONEST);
    expect(copyBodies(s)).toEqual([FAST]);
  });
});
