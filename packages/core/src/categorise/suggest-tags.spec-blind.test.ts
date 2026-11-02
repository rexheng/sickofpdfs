// Spec-blind tests for suggestTags (R92, "Auto tags", kind "Your tags").
//
// Sources:
//   spec R92: "Your tags: once the owner has given a tag to 3 or more readings, a new reading that is close in meaning to them
//     gets that tag as auto." and "A removed auto tag never comes back on that reading."
//   interface: suggestTags(doc, tagged: { tag; vectors }[], removed: Set<string>): string[]. "A tag is suggested only when the
//     owner gave it to >= 3 docs and the doc is close in meaning to them. Never a tag in `removed` (auto tags the owner removed
//     on this doc). At most 3."
//
// The spec does not say how close "close" is, or how closeness to several docs is measured (the middle of them, the nearest,
// the average). So the data below is built so that every sensible reading agrees: each tag's docs are one tight cloud, a
// "close" doc is inside the cloud or within 10 degrees of it, a "far" doc is at 80 degrees or more (cosine under 0.18).
//
// Guesses (also in the report):
//   S1  `vectors.length` is the number of docs the owner gave the tag to. 3 is enough, 2 is not.
//   S2  `removed` holds tag names, compared exactly with the `tag` strings (same case, no trimming).
//   S3  When more than 3 tags are close, the 3 CLOSEST are returned, closest first. Only the "3 closest" and "closest first"
//       tests rely on this; "at most 3" does not.
//   S4  The answer holds the `tag` strings exactly as given, each once.
import { describe, expect, it } from 'vitest';
import { atAngle, axisVector, makeDoc, scatter, seeded, shuffled } from '../../test/spec-blind/categorise-kit';
import { suggestTags } from './topics';

const DIM = 16;
const e = (axis: number): Float32Array => axisVector(DIM, axis);
type Tagged = Parameters<typeof suggestTags>[1];

/** `count` docs of one tight cloud round an axis, given to the owner's tag `tag`. */
function tagNear(tag: string, axis: number, count: number, seed = 1): Tagged[number] {
  const rand = seeded(seed);
  return { tag, vectors: Array.from({ length: count }, () => scatter(e(axis), 0.1, rand)) };
}
const docNear = (axis: number, seed = 100 + axis) => makeDoc(`new-${axis}`, scatter(e(axis), 0.1, seeded(seed)));
const NONE = new Set<string>();

const TAGGED: Tagged = [
  tagNear('economics', 0, 4, 11),
  tagNear('neuroscience', 1, 3, 12),
  tagNear('cryptography', 2, 6, 13),
  tagNear('given-twice', 3, 2, 14),
  tagNear('given-once', 4, 1, 15),
  tagNear('given-never', 5, 0, 16),
];

// ---------------------------------------------------------------------------------------------------------------------
describe('suggestTags: a close doc gets a tag the owner gave to 3 or more docs, nothing else does', () => {
  it.each<[string, ReturnType<typeof docNear>, string[]]>([
    ['close to a tag given to 4 docs', docNear(0), ['economics']],
    ['close to a tag given to exactly 3 docs', docNear(1), ['neuroscience']],
    ['close to a tag given to 6 docs', docNear(2), ['cryptography']],
    ['close to a tag given to only 2 docs', docNear(3), []],
    ['close to a tag given to only 1 doc', docNear(4), []],
    ['close to a tag in the list that has no docs', docNear(5), []],
    ['far from every tag', docNear(9), []],
  ])('%s', (_name, doc, expected) => {
    expect(suggestTags(doc, TAGGED, NONE)).toEqual(expected);
  });

  it('a doc that is the same as both docs of a 2-doc tag still gets nothing', () => {
    const twice = TAGGED[3];
    expect(suggestTags(makeDoc('copy', twice.vectors[0]), TAGGED, NONE)).toEqual([]);
  });

  it.each([0, 1, 2, 3, 4, 5])('the same cloud given to %i docs', (count) => {
    const out = suggestTags(docNear(0), [tagNear('one-cloud', 0, count, 21)], NONE);
    expect(out).toEqual(count >= 3 ? ['one-cloud'] : []);
  });

  it('nothing to suggest from when the owner has no tags', () => {
    expect(suggestTags(docNear(0), [], NONE)).toEqual([]);
  });

  it('the tag string comes back exactly as given (S4)', () => {
    const odd = 'Monetary Policy (UK) · 2008-é';
    expect(suggestTags(docNear(0), [tagNear(odd, 0, 3, 22)], NONE)).toEqual([odd]);
  });
});

describe('suggestTags: close against far, for one tag', () => {
  const economics = tagNear('economics', 0, 4, 31);
  const at = (deg: number) => makeDoc(`at-${deg}`, atAngle(e(0), e(7), deg));

  it.each([0, 3, 6, 10])('a doc %i degrees from the tag is close: it gets the tag', (deg) => {
    expect(suggestTags(at(deg), [economics], NONE)).toEqual(['economics']);
  });

  it.each([80, 90, 110, 150, 180])('a doc %i degrees from the tag is far: it does not', (deg) => {
    expect(suggestTags(at(deg), [economics], NONE)).toEqual([]);
  });

  it('closer is never worse than further: if the far doc gets the tag, so does the near one', () => {
    const got = (deg: number): boolean => suggestTags(at(deg), [economics], NONE).length > 0;
    for (let deg = 0; deg < 180; deg += 5) if (got(deg + 5)) expect(got(deg), `${deg + 5} degrees gets the tag but ${deg} does not`).toBe(true);
  });
});

describe('suggestTags: never a tag the owner removed on this doc', () => {
  const both: Tagged = [tagNear('economics', 0, 4, 41), tagNear('macro', 0, 3, 42), tagNear('neuroscience', 1, 3, 43)];
  const sorted = (xs: string[]): string[] => [...xs].sort();

  it('without removals, a doc close to two tags gets both', () => {
    expect(sorted(suggestTags(docNear(0), both, NONE))).toEqual(['economics', 'macro']);
  });

  it.each<[string, string[], string[]]>([
    ['one removed', ['macro'], ['economics']],
    ['the other removed', ['economics'], ['macro']],
    ['both removed', ['economics', 'macro'], []],
    ['a tag that would not be suggested anyway', ['neuroscience'], ['economics', 'macro']],
    ['a name that is only part of a tag', ['econ'], ['economics', 'macro']],
    ['a name with a different case (S2)', ['Economics'], ['economics', 'macro']],
  ])('%s', (_name, removed, expected) => {
    expect(sorted(suggestTags(docNear(0), both, new Set(removed)))).toEqual(expected);
  });

  it('a removed tag stays out even for a doc that is exactly the same as the tag docs', () => {
    expect(suggestTags(makeDoc('same', both[0].vectors[0]), both, new Set(['economics', 'macro']))).toEqual([]);
  });
});

describe('suggestTags: at most 3', () => {
  // five tags, each given to 3 docs, all within 10 degrees of the doc, at 2, 4, 6, 8 and 10 degrees
  const five: Tagged = [2, 4, 6, 8, 10].map((deg, i) => ({
    tag: `t${deg}`,
    vectors: [0, 1, 2].map(() => atAngle(e(0), e(i + 1), deg)),
  }));
  const doc = makeDoc('doc', e(0));

  it('five close tags give 3, all of them from the five', () => {
    const out = suggestTags(doc, five, NONE);
    expect(out).toHaveLength(3);
    expect(new Set(out).size).toBe(3);
    for (const t of out) expect(five.map((x) => x.tag)).toContain(t);
  });

  it('three close tags give 3, two give 2', () => {
    expect(suggestTags(doc, five.slice(0, 3), NONE)).toHaveLength(3);
    expect(suggestTags(doc, five.slice(0, 2), NONE)).toHaveLength(2);
  });

  it('with one of the five removed, still at most 3', () => {
    expect(suggestTags(doc, five, new Set(['t2'])).length).toBeLessThanOrEqual(3);
    expect(suggestTags(doc, five, new Set(['t2'])).length, 'four are left, so 3 are suggested').toBe(3);
    expect(suggestTags(doc, five, new Set(['t2'])), 'the removed tag is not suggested').not.toContain('t2');
  });

  it('guess S3: the 3 closest, closest first', () => {
    expect(suggestTags(doc, five, NONE)).toEqual(['t2', 't4', 't6']);
  });

  it('guess S3: the same 3 whatever order the tags come in', () => {
    for (const seed of [1, 2, 3, 4]) expect(suggestTags(doc, shuffled(five, seed), NONE)).toEqual(['t2', 't4', 't6']);
  });

  it('guess S3: a closer tag beats a tag given to more docs', () => {
    const crowded = { tag: 'crowded', vectors: Array.from({ length: 20 }, () => atAngle(e(0), e(9), 9)) };
    const out = suggestTags(doc, [crowded, ...five.slice(0, 3)], NONE);
    expect(out).toEqual(['t2', 't4', 't6']);
  });
});

describe('suggestTags: order and mutation', () => {
  it('the set of suggestions does not depend on the order of the tags', () => {
    const doc = docNear(0);
    const base = suggestTags(doc, TAGGED, NONE);
    for (const seed of [1, 2, 3, 4, 5]) expect(suggestTags(doc, shuffled(TAGGED, seed), NONE)).toEqual(base);
  });

  it('the doc, the tags and the removed set are left alone', () => {
    const doc = docNear(0);
    const tagged = [tagNear('economics', 0, 4, 51), tagNear('macro', 0, 3, 52)];
    const removed = new Set(['macro']);
    const before = JSON.stringify({ d: Array.from(doc.vector), t: tagged.map((t) => [t.tag, t.vectors.map((v) => Array.from(v))]), r: [...removed] });
    suggestTags(doc, tagged, removed);
    const after = JSON.stringify({ d: Array.from(doc.vector), t: tagged.map((t) => [t.tag, t.vectors.map((v) => Array.from(v))]), r: [...removed] });
    expect(after).toBe(before);
  });

  it('the answer is a fresh array each time', () => {
    const doc = docNear(0);
    const first = suggestTags(doc, TAGGED, NONE);
    first.push('junk');
    expect(suggestTags(doc, TAGGED, NONE)).toEqual(['economics']);
  });
});
