// Spec-blind tests for CL2's planReparent(loser, winner, rows): two computers made two documents for one stamped paper,
// and an alias row later shows they are the same. The notes of the duplicate move into the smaller id.
//
// Sources: spec "Sync rules" (stamped re-downloads are aliases of the first copy; "Notes get a random id once and are
// never copied"); the plan's CL2 rules ("Two aliases for one fingerprint: the smaller document id wins"; history merges per
// field) and CL9 ("a pulled alias that names a local document as a duplicate re-parents its notes into the smaller id");
// the plan's Risks ("Notes are split, never lost"); the caller's brief (it "moves notes, locations, aliases and history to
// the winner and leaves drafts in place"); the interface file (the result is
// `{ winner, loser, moves, repointAliases, addAlias, history, leftInPlace }`).
//
// GUESS (input shape): `rows` holds the local rows that point at the loser, keyed by table, in camelCase with their rev and
// hlc, plus both documents' history rows. The history array also answers `.loser` and `.winner`, so either reading works.
// GUESS (output shape): the inner shape of `moves`, `repointAliases` and `leftInPlace` is open, so the tests read them with
// tolerant readers (ids, rows, `{ table, id }` items, or keyed by table).
import { describe, expect, it } from 'vitest';
import { MIN, T0, type Wire, bitset, bytesOf, claudeMeta, commentRow, hex64, historyRow, idsIn, locationRow, markRow, orBytes, planReparent, stamp, targetsIn, threadRow, uuid, aliasRow } from '../../test/spec-blind/sync-kit';

const W = hex64('1a'); // the smaller id: the winner
const L = hex64('c4'); // the duplicate
const X = hex64('e9'); // a third stamped copy, already an alias of the duplicate
const TAB = '5d9b2c1e-0000-4000-8000-00000000ab01';
const HOUR = 60 * MIN;

const synced = (row: Wire, n: number): Wire => ({ ...row, rev: 2, hlc: stamp(T0 + n * MIN, 0, 'devB') });

const m1 = uuid(1, 'aa');
const m2 = uuid(2, 'aa'); // in Trash
const t1 = uuid(1, '7b');
const tDraft = uuid(2, '7b'); // a new thread whose first comment is still being typed
const c1 = uuid(1);
const c2 = uuid(2); // Claude's reply
const cDraft = uuid(3);
const loc1 = hex64('21');
const loc2 = hex64('22');

const hL = historyRow(L, { firstOpened: T0, lastOpened: T0 + 2 * HOUR, openCount: 4, readingMs: 900_000, pagesVisited: bitset([0, 1, 2, 3]) });
const hW = historyRow(W, { firstOpened: T0 + HOUR, lastOpened: T0 + 5 * HOUR, openCount: 2, readingMs: 1_200_000, pagesVisited: bitset([3, 8]) });

function rows(histories: Wire[]) {
  const list = histories.map((h, i) => synced(h, 90 + i));
  const history = Object.assign(list, {
    loser: list.find((h) => h.documentId === L) ?? null,
    winner: list.find((h) => h.documentId === W) ?? null,
  });
  return {
    marks: [synced(markRow({ id: m1, documentId: L }), 1), synced(markRow({ id: m2, documentId: L, deletedAt: T0 + 3 * MIN }), 2)],
    threads: [synced(threadRow({ id: t1, documentId: L }), 3), { ...threadRow({ id: tDraft, documentId: L, draftOfTab: TAB }), rev: 0, hlc: stamp(T0 + 4 * MIN, 0, 'devB') }],
    comments: [
      synced(commentRow({ id: c1, threadId: t1, documentId: L, body: 'Owner: why 2006?' }), 5),
      synced(commentRow({ id: c2, threadId: t1, documentId: L, body: 'Claude: the policy began then (p. 3).', author: 'claude', meta: claudeMeta() }), 6),
      { ...commentRow({ id: cDraft, threadId: tDraft, documentId: L, body: 'still typing', draftOfTab: TAB }), rev: 0, hlc: stamp(T0 + 7 * MIN, 0, 'devB') },
    ],
    locations: [
      synced(locationRow({ id: loc1, documentId: L }), 8),
      synced(locationRow({ id: loc2, documentId: L, kind: 'file', canonical: 'did-2024.pdf', raw: 'did-2024.pdf' }), 9),
    ],
    aliases: [synced(aliasRow(X, L), 10)],
    history,
  };
}

const SENT = [m1, m2, t1, c1, c2, loc1, loc2];
const DRAFTS = [tDraft, cDraft];
const asRow = (x: unknown): Wire => {
  const o = (x ?? {}) as Wire;
  return (o.row && typeof o.row === 'object' ? o.row : o) as Wire;
};

describe('planReparent', () => {
  it('moves every sent note of the duplicate, trashed ones too, and its locations, to the smaller id, keeping their ids', () => {
    const plan = planReparent(L, W, rows([hL, hW]));
    expect(plan.winner).toBe(W);
    expect(plan.loser).toBe(L);
    const moved = idsIn(plan.moves);
    for (const id of SENT) expect(moved, `moves ${id}`).toContain(id);
    for (const t of targetsIn(plan.moves)) expect(t).toBe(W);
    // Notes are never copied: nothing in the plan is a new id.
    const known = new Set([...SENT, ...DRAFTS, X, L, W]);
    for (const id of moved) expect(known, `unexpected id ${id} in moves`).toContain(id);
  });

  it('leaves drafts in place', () => {
    const plan = planReparent(L, W, rows([hL, hW]));
    const moved = idsIn(plan.moves);
    const left = idsIn(plan.leftInPlace);
    for (const id of DRAFTS) {
      expect(moved, `does not move draft ${id}`).not.toContain(id);
      expect(left, `leaves draft ${id}`).toContain(id);
    }
    for (const id of SENT) expect(left, `does not leave sent ${id}`).not.toContain(id);
  });

  it("repoints the duplicate's aliases and adds its own fingerprint as an alias of the winner", () => {
    const plan = planReparent(L, W, rows([hL, hW]));
    expect(idsIn(plan.repointAliases)).toContain(X);
    expect(asRow(plan.addAlias)).toMatchObject({ sha256: L, documentId: W });
  });

  it('merges the two reading histories into one for the winner', () => {
    const h = asRow(planReparent(L, W, rows([hL, hW])).history);
    expect(h).toMatchObject({ documentId: W, firstOpened: T0, lastOpened: T0 + 5 * HOUR });
    expect(bytesOf(h.pagesVisited)).toEqual(orBytes(bitset([0, 1, 2, 3]), bitset([3, 8])));
    expect(h.openCount).toBeGreaterThanOrEqual(4);
    expect(h.readingMs).toBeGreaterThanOrEqual(1_200_000);
  });

  it("gives the winner the duplicate's history when the winner has none", () => {
    const h = asRow(planReparent(L, W, rows([hL])).history);
    expect(h).toMatchObject({ documentId: W, firstOpened: T0, lastOpened: T0 + 2 * HOUR, openCount: 4, readingMs: 900_000 });
    expect(bytesOf(h.pagesVisited)).toEqual(bytesOf(bitset([0, 1, 2, 3])));
  });
});
