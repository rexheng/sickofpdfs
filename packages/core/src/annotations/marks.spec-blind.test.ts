// Spec-blind table tests for planStyle (Phase 2, S3).
//
// Sources: spec "Marks" (one passage can carry several styles; "applying a style that already covers the whole selection
// removes it from that selection, splitting the mark if needed. Comments are separate from styles, so removing or
// splitting a style never removes a comment"); contracts section 2 ("Several styles can overlap. There is one MarkRow per
// style and continuous range, and a range may cross pages. planStyle toggles a style off when it already covers the whole
// target, and splits a mark as shrink plus create (new id)"; "Marks and threads are independent rows"); the plan's S3
// ("planStyle toggles, splits and overlaps, which never touch threads") and Gate 1 point 2 ("Ctrl+U with nothing selected
// does nothing").
//
// How the tests read a plan: they apply it to the marks (remove the ids in `remove`, give each `shrink` id its new range,
// add each `create`) and compare what is left. That way a plan may be built any way the code likes. Ranges are half open,
// [start, end), in reading order: a position is (page, index).
import { describe, expect, it } from 'vitest';
import type { MarkId } from '../ids';
import type { CharPos } from '../model/anchor';
import type { MarkColor, MarkRow, MarkStyle } from '../model/rows';
import { deepFreeze } from '../../test/spec-blind/anchoring-fixtures';
import { planStyle } from './marks';

type Style = Exclude<MarkStyle, 'area'>;
type Pos = [page: number, index: number];
const cmp = (a: Pos, b: Pos) => a[0] - b[0] || a[1] - b[1];
const pos = (p: CharPos): Pos => [p.page, p.index];
const cp = ([page, index]: Pos): CharPos => ({ page, index });

interface M {
  id: string;
  style: MarkStyle;
  color: MarkColor | null;
  from: Pos;
  to: Pos;
}

function row(m: M): MarkRow {
  return {
    id: m.id as MarkId,
    documentId: 'd'.repeat(64) as MarkRow['documentId'],
    style: m.style,
    color: m.color,
    anchor: { kind: 'text', quote: { quote: 'x', prefix: '', suffix: '' }, start: cp(m.from), end: cp(m.to), rects: [] },
    pageIndex: m.from[0],
    sortKey: m.from[0] * 1e6 + m.from[1],
    author: 'me',
    createdAt: 0,
    updatedAt: 0,
    rev: 1,
    hlc: '0000000000000-0000-dev',
    deletedAt: null,
  };
}
const area = (id: string): MarkRow => ({ ...row({ id, style: 'area', color: null, from: [0, 0], to: [0, 0] }), anchor: { kind: 'area', page: 0, rect: [0.1, 0.1, 0.5, 0.5], dHash: '0'.repeat(16) } });

interface Piece {
  id: string | null; // null: created by the plan
  style: MarkStyle;
  color: MarkColor | null;
  from: Pos;
  to: Pos;
}

/** What the document holds after the plan is carried out. */
function carryOut(existing: MarkRow[], plan: ReturnType<typeof planStyle>): Piece[] {
  const gone = new Set<string>(plan.remove);
  const moved = new Map(plan.shrink.map((s) => [s.id as string, s]));
  const pieces: Piece[] = [];
  for (const m of existing) {
    if (gone.has(m.id)) continue;
    const s = moved.get(m.id);
    if (m.anchor.kind !== 'text') {
      pieces.push({ id: m.id, style: m.style, color: m.color, from: [0, 0], to: [0, 0] });
      continue;
    }
    pieces.push({ id: m.id, style: m.style, color: m.color, from: pos(s ? s.start : m.anchor.start), to: pos(s ? s.end : m.anchor.end) });
  }
  for (const c of plan.create) pieces.push({ id: null, style: c.style, color: c.color, from: pos(c.start), to: pos(c.end) });
  return pieces;
}

/** The text covered by (style, colour), as sorted disjoint ranges: touching or overlapping pieces are joined. */
function coverage(pieces: Piece[], style: MarkStyle, color: MarkColor | null): [Pos, Pos][] {
  const r = pieces
    .filter((p) => p.style === style && p.color === color && cmp(p.from, p.to) < 0)
    .map((p) => [p.from, p.to] as [Pos, Pos])
    .sort((a, b) => cmp(a[0], b[0]));
  const out: [Pos, Pos][] = [];
  for (const x of r) {
    const last = out[out.length - 1];
    if (last && cmp(x[0], last[1]) <= 0) {
      if (cmp(x[1], last[1]) > 0) last[1] = x[1];
    } else out.push([x[0], x[1]]);
  }
  return out;
}

interface Case {
  name: string;
  existing: M[];
  target: [Pos, Pos];
  style: Style;
  color: MarkColor | null;
  /** The (style, colour) coverage that must remain, as [from, to] ranges. */
  covers: [Pos, Pos][];
  /** Marks that must come through exactly as they are. */
  untouched?: string[];
  /** Coverage of another colour of the same style, when the case says something about it. */
  otherColour?: { color: MarkColor; covers: [Pos, Pos][] };
}

const H = (id: string, from: Pos, to: Pos, color: MarkColor = 1): M => ({ id, style: 'highlight', color, from, to });
const U = (id: string, from: Pos, to: Pos, color: MarkColor = 1): M => ({ id, style: 'underline', color, from, to });

const CASES: Case[] = [
  { name: 'nothing there: one new mark over exactly the target', existing: [], target: [[0, 10], [0, 20]], style: 'highlight', color: 1, covers: [[[0, 10], [0, 20]]] },
  {
    name: 'the same style and colour over the whole target: it is toggled off (the mark goes)',
    existing: [H('a', [0, 10], [0, 20])],
    target: [[0, 10], [0, 20]],
    style: 'highlight',
    color: 1,
    covers: [],
  },
  {
    name: 'toggling off in the middle splits the mark in two',
    existing: [H('a', [0, 10], [0, 50])],
    target: [[0, 20], [0, 30]],
    style: 'highlight',
    color: 1,
    covers: [[[0, 10], [0, 20]], [[0, 30], [0, 50]]],
  },
  { name: 'toggling off at the start of a mark shortens it', existing: [H('a', [0, 10], [0, 50])], target: [[0, 10], [0, 25]], style: 'highlight', color: 1, covers: [[[0, 25], [0, 50]]] },
  { name: 'toggling off at the end of a mark shortens it', existing: [H('a', [0, 10], [0, 50])], target: [[0, 40], [0, 50]], style: 'highlight', color: 1, covers: [[[0, 10], [0, 40]]] },
  {
    name: 'two marks that touch cover the target together: toggling off cuts both',
    existing: [H('a', [0, 10], [0, 30]), H('b', [0, 30], [0, 60])],
    target: [[0, 20], [0, 40]],
    style: 'highlight',
    color: 1,
    covers: [[[0, 10], [0, 20]], [[0, 40], [0, 60]]],
  },
  {
    name: 'part of the target is already covered: the style is applied to all of it, as one mark',
    existing: [H('a', [0, 10], [0, 30])],
    target: [[0, 20], [0, 50]],
    style: 'highlight',
    color: 1,
    covers: [[[0, 10], [0, 50]]],
  },
  {
    name: 'the target joins two marks across the gap between them',
    existing: [H('a', [0, 10], [0, 30]), H('b', [0, 40], [0, 60])],
    target: [[0, 20], [0, 50]],
    style: 'highlight',
    color: 1,
    covers: [[[0, 10], [0, 60]]],
  },
  {
    name: 'the target swallows a smaller mark',
    existing: [H('a', [0, 25], [0, 30])],
    target: [[0, 20], [0, 50]],
    style: 'highlight',
    color: 1,
    covers: [[[0, 20], [0, 50]]],
  },
  {
    name: 'a mark elsewhere on the page is left alone, not joined across the gap',
    existing: [H('a', [0, 100], [0, 120])],
    target: [[0, 10], [0, 20]],
    style: 'highlight',
    color: 1,
    covers: [[[0, 10], [0, 20]], [[0, 100], [0, 120]]],
    untouched: ['a'],
  },
  {
    name: 'another colour of the same style over the target: it recolours, so the old colour leaves the target',
    existing: [H('a', [0, 10], [0, 50], 1)],
    target: [[0, 20], [0, 30]],
    style: 'highlight',
    color: 3,
    covers: [[[0, 20], [0, 30]]],
    otherColour: { color: 1, covers: [[[0, 10], [0, 20]], [[0, 30], [0, 50]]] },
    // a reading: choosing green on yellow text turns it green; it does not switch highlighting off
  },
  {
    name: 'a different style on the same text is a second mark: both styles share the text',
    existing: [H('a', [0, 10], [0, 50])],
    target: [[0, 10], [0, 50]],
    style: 'underline',
    color: 1,
    covers: [[[0, 10], [0, 50]]],
    untouched: ['a'],
  },
  {
    name: 'toggling underline off inside text that is also highlighted leaves the highlight whole',
    existing: [H('h', [0, 10], [0, 50]), U('u', [0, 10], [0, 50])],
    target: [[0, 20], [0, 30]],
    style: 'underline',
    color: 1,
    covers: [[[0, 10], [0, 20]], [[0, 30], [0, 50]]],
    untouched: ['h'],
  },
  {
    name: 'a range across a page break: the split falls on the right side of the break',
    existing: [H('a', [0, 90], [1, 30])],
    target: [[0, 95], [1, 10]],
    style: 'highlight',
    color: 1,
    covers: [[[0, 90], [0, 95]], [[1, 10], [1, 30]]],
  },
  {
    name: 'a target across pages over nothing: one mark across the pages',
    existing: [],
    target: [[0, 95], [2, 10]],
    style: 'highlight',
    color: 2,
    covers: [[[0, 95], [2, 10]]],
  },
  {
    name: 'bold has no colour: it toggles on and then off',
    existing: [{ id: 'b', style: 'bold', color: null, from: [0, 10], to: [0, 40] }],
    target: [[0, 20], [0, 30]],
    style: 'bold',
    color: null,
    covers: [[[0, 10], [0, 20]], [[0, 30], [0, 40]]],
  },
  {
    name: 'an area mark in the list is ignored: no crash, never changed',
    existing: [H('a', [0, 10], [0, 20])],
    target: [[0, 10], [0, 20]],
    style: 'highlight',
    color: 1,
    covers: [],
    untouched: ['area'],
  },
  {
    name: 'nothing selected (an empty target): nothing happens',
    existing: [H('a', [0, 10], [0, 50])],
    target: [[0, 30], [0, 30]],
    style: 'highlight',
    color: 1,
    covers: [[[0, 10], [0, 50]]],
    untouched: ['a'],
  },
];

describe('planStyle', () => {
  it.each(CASES)('$name', ({ existing, target, style, color, covers, untouched = [], otherColour }) => {
    const rows = deepFreeze([...existing.map(row), ...(untouched.includes('area') ? [area('area')] : [])]); // frozen: a plan may not edit its input
    const before = JSON.stringify(rows);
    const plan = planStyle(rows, { start: cp(target[0]), end: cp(target[1]) }, style, color);

    expect(JSON.stringify(rows), 'the marks passed in are not changed').toBe(before);
    expect(Object.keys(plan).sort(), 'a plan holds marks only; threads are never part of it').toEqual(['create', 'remove', 'shrink']);

    // 1. every new mark has the asked style, and the asked colour (or the colour of the old mark it is the other half of)
    const oldColours = new Set(existing.filter((m) => m.style === style).map((m) => m.color));
    for (const c of plan.create) {
      expect(c.style).toBe(style);
      expect(c.color === color || oldColours.has(c.color), `colour ${String(c.color)}`).toBe(true);
      expect(cmp(pos(c.start), pos(c.end)), 'a new mark is not empty').toBeLessThan(0);
    }
    // 2. only marks of the asked style are changed or removed
    const wrongStyle = new Set(existing.filter((m) => m.style !== style).map((m) => m.id).concat(untouched.includes('area') ? ['area'] : []));
    for (const id of [...plan.remove, ...plan.shrink.map((s) => s.id)]) expect(wrongStyle.has(id), `${id} is another style and must not be touched`).toBe(false);
    for (const id of untouched) {
      expect(plan.remove).not.toContain(id);
      expect(plan.shrink.map((s) => s.id)).not.toContain(id);
    }
    // 3. what the text looks like afterwards
    const after = carryOut(rows, plan);
    expect(coverage(after, style, color)).toEqual(covers);
    if (otherColour) expect(coverage(after, style, otherColour.color)).toEqual(otherColour.covers);
    // 4. other styles are exactly as before
    for (const other of ['highlight', 'underline', 'bold', 'strike'] as const) {
      if (other === style) continue;
      for (const c of [1, 2, 3, 4, 5, null] as const) {
        expect(coverage(after, other, c), `${other}/${c ?? 'none'}`).toEqual(coverage(carryOut(rows, { create: [], shrink: [], remove: [] }), other, c));
      }
    }
    // 5. one row per style, colour and continuous range: no two rows of one kind overlap or touch
    const same = after.filter((p) => p.style === style && p.color === color && cmp(p.from, p.to) < 0).sort((a, b) => cmp(a.from, b.from));
    for (let i = 1; i < same.length; i++) expect(cmp(same[i - 1].to, same[i].from), 'rows of one kind are separate ranges').toBeLessThan(0);
  });

  it('applying the same style twice is a round trip: on, then off, leaves the text as it was', () => {
    const target: [CharPos, CharPos] = [cp([0, 20]), cp([1, 5])];
    const on = planStyle([], { start: target[0], end: target[1] }, 'strike', 4);
    expect(on.create).toHaveLength(1);
    const marks = on.create.map((c, i) => row({ id: `n${i}`, style: c.style, color: c.color, from: pos(c.start), to: pos(c.end) }));
    const off = planStyle(marks, { start: target[0], end: target[1] }, 'strike', 4);
    expect(coverage(carryOut(marks, off), 'strike', 4)).toEqual([]);
  });
});
