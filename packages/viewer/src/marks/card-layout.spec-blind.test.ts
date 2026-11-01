// Spec-blind table tests for layoutCards (S7, packages/viewer/src/marks/card-layout.ts).
//
// Sources: the plan's S7 ("layoutCards: each card sits at its anchor's top, collisions are pushed down, and the active
// card stays level with its mark"), the spec's Ctrl+Alt+M flow point 5 ("Cards line up with their marks down the margin,
// like Google Docs. The active card moves left and its mark darkens"), the plan's done-when 4 ("A clicked card turns light,
// moves 12 px left") and S4 (cards: "10 px gaps, and a 12 px shift for the active card"). The 12 px shift is not tested here:
// it belongs to the card (ThreadCard's CSS, token --sop-card-shift), not to the vertical layout.
//
// The plan gives the name layoutCards and nothing else: not the argument or the result. The adapter below is the one place
// that says what is GUESSED, and tolerates the obvious variants:
//   layoutCards(cards: { id, anchorTop, height }[], options?: { activeId?, gap? })
//   returns, for each card, its top in px (an array of { id, top }, a Map or a plain object).
// "Collisions are pushed down" is read the Google Docs way: each card goes to its anchor, a card that would overlap the
// one above moves down just far enough, and the active card keeps its anchor while its neighbours make room.
import { describe, expect, it } from 'vitest';
import * as cardLayout from './card-layout';

interface Card {
  id: string;
  anchorTop: number;
  height: number;
}
interface Placed {
  top: number;
}

const GAP = 10; // S4: "10 px gaps"

const exported = cardLayout as unknown as Record<string, unknown>;
const layoutFn = (typeof exported.layoutCards === 'function' ? exported.layoutCards : null) as ((...a: unknown[]) => unknown) | null;

function layout(cards: Card[], o: { activeId?: string | null } = {}): Map<string, Placed> {
  if (!layoutFn) throw new Error(`card-layout.ts does not export layoutCards. It exports: ${Object.keys(exported).join(', ') || '(nothing)'}`);
  // each card under every name a reader might use for the same number
  const input = cards.map((c) => ({ ...c, top: c.anchorTop, y: c.anchorTop, markTop: c.anchorTop, anchorY: c.anchorTop, h: c.height }));
  const active = o.activeId ?? null;
  const out = layoutFn(input, { gap: GAP, gapPx: GAP, spacing: GAP, activeId: active, active, activeThreadId: active, activeCardId: active });
  return read(out);
}

function numberFrom(o: Record<string, unknown>, names: string[]): number | undefined {
  for (const n of names) if (typeof o[n] === 'number') return o[n];
  return undefined;
}

function read(out: unknown): Map<string, Placed> {
  const result = new Map<string, Placed>();
  const place = (id: string, v: unknown) => {
    if (typeof v === 'number') result.set(id, { top: v });
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const top = numberFrom(o, ['top', 'y']);
      if (top === undefined) throw new Error(`layoutCards gave no top for card ${id}: ${JSON.stringify(v)}`);
      result.set(id, { top });
    } else throw new Error(`layoutCards gave an unreadable result for card ${id}: ${JSON.stringify(v)}`);
  };
  if (out instanceof Map) for (const [k, v] of out as Map<unknown, unknown>) place(String(k), v);
  else if (Array.isArray(out)) for (const v of out as Record<string, unknown>[]) place(String(v.id), v);
  else if (out && typeof out === 'object') for (const [k, v] of Object.entries(out)) place(k, v);
  else throw new Error(`layoutCards returned ${JSON.stringify(out)}`);
  return result;
}

const tops = (cards: Card[], p: Map<string, Placed>) => cards.map((c) => p.get(c.id)!.top);

/** No two cards overlap, whatever the order they were given in. */
function expectNoOverlap(cards: Card[], p: Map<string, Placed>) {
  const boxes = cards.map((c) => ({ id: c.id, top: p.get(c.id)!.top, bottom: p.get(c.id)!.top + c.height })).sort((a, b) => a.top - b.top);
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].top, `card ${boxes[i].id} (top ${boxes[i].top}) against card ${boxes[i - 1].id} (bottom ${boxes[i - 1].bottom})`).toBeGreaterThanOrEqual(boxes[i - 1].bottom - 1e-9);
}

const card = (id: string, anchorTop: number, height = 80): Card => ({ id, anchorTop, height });

describe('layoutCards: cards follow their marks', () => {
  it('cards far enough apart sit exactly at their marks', () => {
    const cards = [card('a', 40), card('b', 300), card('c', 900, 200)];
    const p = layout(cards);
    expect(tops(cards, p)).toEqual([40, 300, 900]);
  });

  it('no cards, one card', () => {
    expect(layout([]).size).toBe(0);
    expect(layout([card('only', 123.5, 60)]).get('only')!.top).toBe(123.5);
  });

  it('a card that would sit on the one above is pushed down, just far enough, and the push runs on down the margin', () => {
    const cards = [card('a', 0, 100), card('b', 20, 100), card('c', 30, 50), card('d', 400, 100)];
    const p = layout(cards);
    const [a, b, c, d] = tops(cards, p);
    expect(a, 'the first card stays at its mark').toBe(0);
    expect(b).toBeGreaterThanOrEqual(100);
    expect(b - 100, 'a card is moved only as far as it must be').toBeLessThanOrEqual(GAP + 6);
    expect(c).toBeGreaterThanOrEqual(b + 100);
    expect(c - (b + 100)).toBeLessThanOrEqual(GAP + 6);
    expect(d, 'a card far below is not dragged along').toBe(400);
    expectNoOverlap(cards, p);
  });

  it('the gap between pushed cards is 10 px (S4: card gaps)', () => {
    const cards = [card('a', 0, 100), card('b', 0, 100), card('c', 0, 100)];
    const p = layout(cards);
    expect(tops(cards, p)).toEqual([0, 110, 220]);
  });

  it('each card is at its mark or packed right under the card above it: nothing floats', () => {
    // 200 random margins: heights 40-240, marks anywhere in 3000 px, a few of them close together
    let seed = 20261101;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let run = 0; run < 200; run++) {
      const n = 1 + Math.floor(rnd() * 12);
      const cards = Array.from({ length: n }, (_, i) => card(`c${i}`, Math.round(rnd() * 3000), 40 + Math.round(rnd() * 200)));
      const p = layout(cards);
      expectNoOverlap(cards, p);
      const byMark = [...cards].sort((x, y) => x.anchorTop - y.anchorTop); // stable: equal marks keep their order
      let prevBottom = -Infinity;
      for (const c of byMark) {
        const top = p.get(c.id)!.top;
        expect(top, `card ${c.id} never moves above its mark`).toBeGreaterThanOrEqual(c.anchorTop - 1e-9);
        if (top > c.anchorTop + 1e-9) expect(top - prevBottom, `card ${c.id} was moved down, so it sits right under the card above`).toBeLessThanOrEqual(GAP + 6);
        prevBottom = top + c.height;
      }
    }
  });

  it('cards given out of order are still laid out in the order of their marks', () => {
    const cards = [card('late', 500), card('early', 10), card('middle', 260)];
    const p = layout(cards);
    expect(p.get('early')!.top).toBe(10);
    expect(p.get('middle')!.top).toBe(260);
    expect(p.get('late')!.top).toBe(500);
    expectNoOverlap(cards, p);
  });

  it('two cards on the very same line keep the order they were made in', () => {
    const cards = [card('first', 100, 70), card('second', 100, 70)];
    const p = layout(cards);
    expect(p.get('first')!.top).toBe(100);
    expect(p.get('second')!.top).toBeGreaterThanOrEqual(170);
  });

  it('cards of different heights', () => {
    const cards = [card('tall', 0, 300), card('short', 100, 40), card('mid', 120, 120)];
    const p = layout(cards);
    expectNoOverlap(cards, p);
    expect(p.get('tall')!.top).toBe(0);
    expect(p.get('short')!.top).toBeGreaterThanOrEqual(300);
    expect(p.get('mid')!.top).toBeGreaterThanOrEqual(p.get('short')!.top + 40);
  });
});

describe('layoutCards: the active card', () => {
  const trio = [card('a', 100, 120), card('b', 130, 120), card('c', 160, 120)];

  it('stays level with its mark, and the others make room around it', () => {
    const p = layout(trio, { activeId: 'b' });
    expect(p.get('b')!.top, 'the active card is at its mark').toBe(130);
    expectNoOverlap(trio, p);
    expect(p.get('a')!.top + 120, 'the card above ends before the active card begins').toBeLessThanOrEqual(130 + 1e-9);
    expect(p.get('c')!.top, 'the card below starts after it').toBeGreaterThanOrEqual(130 + 120 - 1e-9);
  });

  it('whichever card is active, it is the one at its mark', () => {
    for (const c of trio) {
      const p = layout(trio, { activeId: c.id });
      expect(p.get(c.id)!.top, `active ${c.id}`).toBe(c.anchorTop);
      expectNoOverlap(trio, p);
    }
  });

  it('with the active card in a crowd of five on neighbouring lines, none overlap and the order of the marks is kept', () => {
    const crowd = [card('a', 100, 90), card('b', 110, 90), card('c', 120, 90), card('d', 130, 90), card('e', 140, 90)];
    const p = layout(crowd, { activeId: 'c' });
    expect(p.get('c')!.top).toBe(120);
    expectNoOverlap(crowd, p);
    const order = tops(crowd, p);
    for (let i = 1; i < order.length; i++) expect(order[i], 'cards keep the order of their marks').toBeGreaterThan(order[i - 1]);
  });

  it('an active card whose neighbours do not collide changes nothing for them', () => {
    const cards = [card('a', 0, 80), card('b', 400, 80), card('c', 900, 80)];
    const p = layout(cards, { activeId: 'b' });
    expect(tops(cards, p)).toEqual([0, 400, 900]);
  });
});
