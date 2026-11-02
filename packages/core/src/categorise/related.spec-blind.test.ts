// Spec-blind tests for related (R92, "Smart sorting").
//
// Sources:
//   spec R92: "'Related readings' lists the 5 closest readings by meaning, in About this PDF and in the library's details panel."
//   interface: related(doc, all, n?): string[]  // the n (default 5) closest ids, never doc itself
//   brief: the closest ids in order, never the doc itself, n respected, ties stable.
//
// Data: the query is the unit vector along axis 0. Each candidate is turned `deg` degrees away from it towards an axis of its
// own, so its cosine to the query is cos(deg) and no two candidates share a similarity. The expected order is "smallest angle
// first" with no maths in the expectation.
//
// Guesses (also in the report):
//   R1  "never doc itself" is by id: a doc in `all` with the query's id is skipped, whatever its vector.
//   R2  A different doc with the same vector (a second copy of a PDF) is a perfectly good related reading, and comes first.
//   R3  Ties: the spec only says "stable". Input order (stable sort) and id order are both accepted where the input is not
//       already in id order; where it is, both give one answer and the test pins it.
//   R4  There is no similarity cut-off: the n closest are returned even when they are not close (cosine below 0).
//   R5  Vectors are unit length (as the embedder makes them), so cosine and dot product rank alike.
import { describe, expect, it } from 'vitest';
import { atAngle, axisVector, cosine, makeDoc, scatter, seeded, shuffled, snapshot } from '../../test/spec-blind/categorise-kit';
import { related } from './topics';

const DIM = 16;
const e = (axis: number): Float32Array => axisVector(DIM, axis);

const query = makeDoc('q', e(0), 'Inflation targeting', 'How central banks target inflation');
const ANGLES = [5, 12, 20, 28, 35, 44, 52, 61, 70, 79, 85, 88];
const id = (deg: number): string => `c${String(deg).padStart(3, '0')}`;
const cands = ANGLES.map((deg, i) => makeDoc(id(deg), atAngle(e(0), e(i + 1), deg)));
const RANKED = ANGLES.map(id); // closest first
const all = [query, ...cands];

describe('related: the closest ids, in order, never the doc itself', () => {
  it('default n is 5: the 5 closest, closest first', () => {
    expect(related(query, all)).toEqual(RANKED.slice(0, 5));
  });

  it.each([1, 2, 3, 5, 8, 12])('n = %i gives the %i closest, closest first', (n) => {
    expect(related(query, all, n)).toEqual(RANKED.slice(0, n));
  });

  it('n = 0 gives nothing', () => {
    expect(related(query, all, 0)).toEqual([]);
  });

  it.each([13, 50])('n = %i is more than there is: every other doc, closest first, and not the doc itself', (n) => {
    expect(related(query, all, n)).toEqual(RANKED);
  });

  it('the input order does not change the answer', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) expect(related(query, shuffled(all, seed), 50)).toEqual(RANKED);
    expect(related(query, [...all].reverse())).toEqual(RANKED.slice(0, 5));
  });

  it('the query need not be in `all`: all of `all` can be returned', () => {
    expect(related(query, cands, 3)).toEqual(RANKED.slice(0, 3));
    expect(related(query, cands, 50)).toEqual(RANKED);
  });

  it('the doc itself is never returned, even when it is the nearest thing in `all` (R1)', () => {
    const out = related(query, all, 50);
    expect(out).not.toContain('q');
    expect(out).toHaveLength(ANGLES.length);
  });

  it('a stale copy of the doc under the same id, with another vector, is skipped too (R1)', () => {
    const stale = makeDoc('q', atAngle(e(0), e(14), 1));
    expect(related(query, [stale, ...all], 50)).toEqual(RANKED);
    expect(related(query, [stale, ...all], 50)).not.toContain('q');
  });

  it('another doc with exactly the same vector is related, and comes first (R2)', () => {
    const copy = makeDoc('q-copy', e(0));
    expect(related(query, [...all, copy], 3)).toEqual(['q-copy', ...RANKED.slice(0, 2)]);
  });

  it('nothing to relate to gives []', () => {
    expect(related(query, [])).toEqual([]);
    expect(related(query, [query])).toEqual([]);
  });

  it('the list is left as it was and the answer is a fresh array', () => {
    const list = shuffled(all, 9);
    const before = snapshot(list);
    const first = related(query, list);
    expect(snapshot(list)).toBe(before);
    first.push('junk');
    expect(related(query, list)).toEqual(RANKED.slice(0, 5));
  });

  it('a different doc as the query ranks by its own neighbours', () => {
    const other = cands[3]; // c028
    const near = makeDoc('near-other', atAngle(other.vector, e(15), 3));
    const out = related(other, [...all, near], 2);
    expect(out[0]).toBe('near-other');
    expect(out).not.toContain(other.id);
  });
});

describe('related: ranking by meaning on a library of random vectors (R5)', () => {
  const rand = seeded(6);
  const docs = Array.from({ length: 41 }, (_, i) => makeDoc(`r${String(i).padStart(2, '0')}`, scatter(new Float32Array(DIM), 1, rand)));
  const [q, ...rest] = docs;
  const expected = rest
    .map((d) => ({ id: d.id, sim: cosine(q.vector, d.vector) }))
    .sort((a, b) => b.sim - a.sim);

  it('the fixture has no near-ties (so the order below is not a rounding accident)', () => {
    for (let i = 1; i < expected.length; i++) expect(expected[i - 1].sim - expected[i].sim).toBeGreaterThan(1e-5);
  });

  it('the 5 closest by cosine, in order', () => {
    expect(related(q, docs)).toEqual(expected.slice(0, 5).map((x) => x.id));
  });

  it('the whole list, in order (R4: nothing is cut off, even negative cosines)', () => {
    expect(expected[expected.length - 1].sim).toBeLessThan(0);
    expect(related(q, docs, 100)).toEqual(expected.map((x) => x.id));
  });

  it('every n gives a prefix of the same ranking', () => {
    for (const n of [1, 2, 4, 7, 20, 40]) expect(related(q, shuffled(docs, n), n)).toEqual(expected.slice(0, n).map((x) => x.id));
  });
});

describe('related: no cut-off (R4)', () => {
  it('docs that are not close at all are still returned, last, when there is room', () => {
    const far = [100, 150, 180].map((deg, i) => makeDoc(`far${deg}`, atAngle(e(0), e(13 + (i % 3)), deg)));
    const out = related(query, [...all, ...far], 50);
    expect(out).toEqual([...RANKED, 'far100', 'far150', 'far180']);
  });
});

describe('related: ties are stable (R3)', () => {
  const tie = (name: string) => makeDoc(`tie-${name}`, atAngle(e(0), e(14), 30));
  // sorted by id in the input, so "input order" and "id order" agree
  const sortedInput = [query, cands[0], tie('a'), tie('b'), tie('c'), cands[8]]; // c005, tie x3 at 30 degrees, c070

  it('tied docs come out together, between the docs with a higher and a lower similarity, in one repeatable order', () => {
    const out = related(query, sortedInput, 50);
    expect(out).toEqual(['c005', 'tie-a', 'tie-b', 'tie-c', 'c070']);
    expect(related(query, sortedInput, 50)).toEqual(out);
  });

  it('when a tie is cut by n, the first of the tied docs is the one kept', () => {
    expect(related(query, sortedInput, 2)).toEqual(['c005', 'tie-a']);
    expect(related(query, sortedInput, 3)).toEqual(['c005', 'tie-a', 'tie-b']);
  });

  it('the order inside a tie is the input order or the id order, never anything else', () => {
    const input = [query, tie('c'), tie('a'), tie('b')];
    const out = related(query, input, 50);
    expect([['tie-c', 'tie-a', 'tie-b'], ['tie-a', 'tie-b', 'tie-c']]).toContainEqual(out);
    expect(related(query, input, 50)).toEqual(out);
  });

  it('the same input always gives the same answer, 20 times over', () => {
    const input = [query, tie('d'), tie('b'), cands[2], tie('a'), tie('c')];
    const first = related(query, input, 4);
    for (let i = 0; i < 20; i++) expect(related(query, input, 4)).toEqual(first);
  });
});
