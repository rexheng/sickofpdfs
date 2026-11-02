// Spec-blind tests for clusterTopics (R92, "Auto tags", kind "Topics").
//
// Sources:
//   spec R92: "Topics: from 6 readings on, readings that are close in meaning are grouped into topics. Each topic is named from
//     its most telling words, such as 'Inflation · Monetary Policy'. Renaming a topic keeps the new name." and "The vectors stay
//     local ... are rebuilt when needed" (so a topic's key cannot depend on a vector).
//   interface: clusterTopics(docs, opts?: { minDocs?: number }): Topic[]; Topic { key, docIds, name }. "key is stable for the same
//     member set". "Deterministic: the same input in any order gives the same topics. No topic until there are >= 6 docs. Docs
//     that fit nowhere stay out. Names: the 2 most telling words of the topic versus the whole library, Title Case, joined by
//     ' · ', stop words and numbers left out."
//
// How the vectors are built (categorise-kit.ts): groups are tight clouds round one axis; different groups are at right angles,
// so for any sensible algorithm "who belongs together" has one answer and no similarity threshold from the spec is needed.
// Loners sit on axes of their own, at right angles to everything.
//
// Guesses (also in the report):
//   T1  "No topic until there are >= 6 docs" means: the LIBRARY holds fewer than minDocs docs (default 6). It is not a minimum
//       topic size. Groups in these tests have 6 docs, so they pass under either reading; only the 5-doc cases tell them apart.
//   T2  Nothing in the spec says a doc can be in only one topic ("at most 3 auto topic tags" per reading hints at more).
//       So no test demands disjoint topics; the clear groups are at right angles, so they come out disjoint anyway.
//   T3  A topic has at least 2 docs (one doc is not a "group").
//   T4  `key` depends on the member ids alone: not on vectors, texts or the other docs in the library.
//   T5  The spec's example "Inflation · Monetary Policy" has a two-word second part, the interface says "the 2 most telling
//       words". The format test accepts either (2 parts, each Title Case); a separate test pins the interface (one word each).
//   T6  Which of the two words comes first is not tested (the spec does not say).
//   T7  Stop words are the usual English function words (the, of, between, which, their, these, into, during, such, each, while).
//   T8  Words are matched without regard to case ("INFLATION", "Inflation" and "inflation" are one word).
import { describe, expect, it } from 'vitest';
import { axisVector, byCodeUnit, makeDoc, scatter, seeded, shuffled, snapshot } from '../../test/spec-blind/categorise-kit';
import type { Doc } from '../../test/spec-blind/categorise-kit';
import { clusterTopics } from './topics';
import type { Topic } from './topics';

const DIM = 16;
const NOISE = 0.15;

// ---------------------------------------------------------------------------------------------------------------------
// Text for the naming tests. Every doc of a subject carries two telling words (they are in all six docs, several times each).
// Three kinds of trap can be switched on, each one a word that looks MORE common in the group than the telling words:
//   sharedHeavy  analysis / data / results appear in EVERY doc of the library, 6 times each in every doc
//   leanStops    three stop words that only this group's docs use (6 times each)
//   numbers      a year and a small number that only this group's docs use

interface Subject {
  prefix: string;
  axis: number;
  tell: [string, string];
  extras: string[];
  lean: [string, string, string];
  number: string;
  small: string;
}

const GROUPS: Subject[] = [
  {
    prefix: 'a',
    axis: 0,
    tell: ['inflation', 'monetary'],
    extras: ['banks', 'wages', 'prices', 'households', 'firms', 'expectations', 'credibility', 'targeting'],
    lean: ['between', 'which', 'their'],
    number: '2008',
    small: '12',
  },
  {
    prefix: 'b',
    axis: 1,
    tell: ['synaptic', 'hippocampal'],
    extras: ['neurons', 'memory', 'dendrites', 'spines', 'calcium', 'cortex', 'learning', 'receptors'],
    lean: ['these', 'into', 'during'],
    number: '1997',
    small: '31',
  },
  {
    prefix: 'c',
    axis: 2,
    tell: ['lattice', 'encryption'],
    extras: ['signatures', 'hardness', 'security', 'keys', 'proofs', 'circuits', 'noise', 'reductions'],
    lean: ['such', 'each', 'while'],
    number: '2015',
    small: '45',
  },
];

const LONERS: Subject[] = [
  { prefix: 'x', axis: 8, tell: ['sourdough', 'fermentation'], extras: ['starter', 'crumb', 'flour'], lean: ['about', 'over', 'under'], number: '1962', small: '9' },
  { prefix: 'y', axis: 9, tell: ['plumage', 'migration'], extras: ['warblers', 'wetlands', 'flocks'], lean: ['about', 'over', 'under'], number: '1971', small: '8' },
  { prefix: 'z', axis: 10, tell: ['mortgage', 'amortization'], extras: ['lenders', 'escrow', 'deeds'], lean: ['about', 'over', 'under'], number: '1985', small: '7' },
];

const SHARED = ['analysis', 'data', 'results'];
const COMMON_STOPS: Array<[word: string, times: number]> = [
  ['the', 6],
  ['of', 4],
  ['and', 4],
  ['to', 3],
  ['in', 3],
  ['for', 2],
  ['with', 2],
];

interface Traps {
  sharedHeavy?: boolean;
  leanStops?: boolean;
  numbers?: boolean;
}
const ALL_TRAPS: Traps = { sharedHeavy: true, leanStops: true, numbers: true };

const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

function writeText(s: Subject, i: number, traps: Traps, titleOnly: boolean, rand: () => number): { title: string; abstract: string } {
  const e0 = s.extras[i % s.extras.length];
  const e1 = s.extras[(i + 1) % s.extras.length];
  if (titleOnly) return { title: `${cap(s.tell[0])} ${s.tell[1]} ${e0} ${e1}`, abstract: '' };

  const tokens: string[] = [];
  const add = (word: string, times: number, vary = false): void => {
    for (let k = 0; k < times; k++) {
      const r = rand();
      tokens.push(vary ? (r < 0.7 ? word : r < 0.9 ? cap(word) : word.toUpperCase()) : word);
    }
  };
  add(s.tell[0], 3, true); // the 4th is in the title
  add(s.tell[1], 4, true);
  add(e0, 1, true);
  add(e1, 1, true);
  for (const w of SHARED) add(w, traps.sharedHeavy ? 6 : 1);
  for (const [w, n] of COMMON_STOPS) add(w, n);
  if (traps.leanStops) for (const w of s.lean) add(w, 6);
  if (traps.numbers) {
    add(s.number, 6);
    add(s.small, 4);
  }
  const order = shuffled(tokens, 1000 + i + s.axis * 100);
  const sentences: string[] = [];
  for (let k = 0; k < order.length; k += 10) sentences.push(`${cap(order.slice(k, k + 10).join(' '))}.`);
  return { title: `${cap(s.tell[0])} and ${e0}`, abstract: sentences.join(' ') };
}

interface Library {
  docs: Doc[];
  /** prefix of the group -> the ids of its docs */
  groups: Record<string, string[]>;
  loners: string[];
}

function buildLibrary(opts: { seed?: number; traps?: Traps; titleOnly?: boolean; size?: number } = {}): Library {
  const { seed = 1, traps = {}, titleOnly = false, size = 6 } = opts;
  const vecRand = seeded(seed);
  const docs: Doc[] = [];
  const groups: Record<string, string[]> = {};
  for (const s of GROUPS) {
    groups[s.prefix] = [];
    for (let i = 0; i < size; i++) {
      const id = `${s.prefix}${i + 1}`;
      const text = writeText(s, i, traps, titleOnly, seeded(seed * 31 + i + s.axis * 7));
      docs.push(makeDoc(id, scatter(axisVector(DIM, s.axis), NOISE, vecRand), text.title, text.abstract));
      groups[s.prefix].push(id);
    }
  }
  const loners: string[] = [];
  for (const s of LONERS) {
    const id = `${s.prefix}1`;
    const text = writeText(s, 0, traps, titleOnly, seeded(seed * 31 + s.axis));
    docs.push(makeDoc(id, scatter(axisVector(DIM, s.axis), NOISE, vecRand), text.title, text.abstract));
    loners.push(id);
  }
  return { docs, groups, loners };
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

const sortedIds = (ids: readonly string[]): string[] => [...ids].sort(byCodeUnit);
const describeTopics = (topics: readonly Topic[]): string => topics.map((t) => `${t.name} [${t.docIds.join(',')}]`).join(' | ') || '(none)';

function topicHolding(topics: readonly Topic[], id: string): Topic {
  const t = topics.find((topic) => topic.docIds.includes(id));
  if (!t) throw new Error(`no topic holds ${id}; topics: ${describeTopics(topics)}`);
  return t;
}

/** The topics in a form that does not depend on their order or the order of their members. */
function canon(topics: readonly Topic[]): Array<{ key: string; name: string; docIds: string[] }> {
  return topics.map((t) => ({ key: t.key, name: t.name, docIds: sortedIds(t.docIds) })).sort((a, b) => byCodeUnit(a.key, b.key));
}

function expectGroupsFound(lib: Library, topics: readonly Topic[]): void {
  for (const [prefix, ids] of Object.entries(lib.groups)) {
    expect(sortedIds(topicHolding(topics, ids[0]).docIds), `group "${prefix}" came out as: ${describeTopics(topics)}`).toEqual(sortedIds(ids));
  }
}

/** Facts true of any answer (T3), whatever the data. */
function expectWellFormed(topics: readonly Topic[], docs: readonly Doc[]): void {
  const ids = new Set(docs.map((d) => d.id));
  const keys = new Set<string>();
  for (const t of topics) {
    expect(typeof t.key).toBe('string');
    expect(t.key.length).toBeGreaterThan(0);
    expect(keys.has(t.key), `key "${t.key}" is used twice`).toBe(false);
    keys.add(t.key);
    expect(typeof t.name).toBe('string');
    expect(t.docIds.length, `topic "${t.name}" has fewer than 2 docs`).toBeGreaterThanOrEqual(2);
    expect(new Set(t.docIds).size, `topic "${t.name}" lists a doc twice`).toBe(t.docIds.length);
    for (const id of t.docIds) expect(ids.has(id), `topic "${t.name}" holds "${id}", which is not in the library`).toBe(true);
  }
}

/** n docs of one tight cloud round `axis`. */
function cloud(prefix: string, axis: number, n: number, seed: number, noise = 0.1): Doc[] {
  const rand = seeded(seed);
  return Array.from({ length: n }, (_, i) => makeDoc(`${prefix}${i + 1}`, scatter(axisVector(DIM, axis), noise, rand)));
}

// ---------------------------------------------------------------------------------------------------------------------
describe('clusterTopics: no topic until there are 6 docs (T1)', () => {
  it.each([
    ['no docs', [] as Doc[]],
    ['one doc', cloud('d', 3, 1, 1)],
    ['five docs that all mean the same thing', cloud('d', 3, 5, 2)],
  ])('%s give no topics', (_name, docs) => {
    expect(clusterTopics(docs)).toEqual([]);
  });

  it('six docs that all mean the same thing make one topic holding all six', () => {
    const docs = cloud('d', 3, 6, 3);
    const topics = clusterTopics(docs);
    expect(topics, describeTopics(topics)).toHaveLength(1);
    expect(sortedIds(topics[0].docIds)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6']);
    expectWellFormed(topics, docs);
  });

  it.each([6, 12])('%i docs that have nothing in common make no topic', (n) => {
    const rand = seeded(4);
    const docs = Array.from({ length: n }, (_, i) => makeDoc(`u${i + 1}`, scatter(axisVector(DIM, i), 0.1, rand)));
    expect(clusterTopics(docs), 'docs that fit nowhere stay out').toEqual([]);
  });

  it('five close docs and one loner: the library has 6, so the five make a topic and the loner stays out', () => {
    const docs = [...cloud('d', 3, 5, 5), makeDoc('lone', scatter(axisVector(DIM, 9), 0.1, seeded(6)))];
    const topics = clusterTopics(docs);
    expect(topics, describeTopics(topics)).toHaveLength(1);
    expect(sortedIds(topics[0].docIds)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5']);
  });

  it('minDocs lowers the bar: five close docs make a topic when minDocs is 5', () => {
    const topics = clusterTopics(cloud('d', 3, 5, 7), { minDocs: 5 });
    expect(topics).toHaveLength(1);
    expect(sortedIds(topics[0].docIds)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5']);
  });

  it('minDocs lowers the bar, but not below the number of docs: four docs, minDocs 5', () => {
    expect(clusterTopics(cloud('d', 3, 4, 8), { minDocs: 5 })).toEqual([]);
  });

  it('minDocs raises the bar: a library of 21 clear docs gives nothing when minDocs is 22', () => {
    const lib = buildLibrary();
    expect(lib.docs).toHaveLength(21);
    expect(clusterTopics(lib.docs, { minDocs: 22 })).toEqual([]);
  });

  it('minDocs counts the whole library, and "at least" is enough: 21 docs, minDocs 21 (T1)', () => {
    expect(clusterTopics(buildLibrary().docs, { minDocs: 21 }).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('clusterTopics: clear groups come out as separate topics, loners stay out', () => {
  const lib = buildLibrary();
  const topics = clusterTopics(lib.docs);

  it('three groups of six give three topics with exactly their members', () => {
    expect(topics, describeTopics(topics)).toHaveLength(3);
    expectGroupsFound(lib, topics);
  });

  it('no topic mixes two groups (T2: disjointness is not assumed, mixing is wrong)', () => {
    const prefixOf = (id: string): string => id.charAt(0);
    for (const t of topics) expect(new Set(t.docIds.map(prefixOf)).size, `mixed topic: ${t.name} [${t.docIds.join(',')}]`).toBe(1);
  });

  it('the loners are in no topic', () => {
    const held = new Set(topics.flatMap((t) => t.docIds));
    for (const id of lib.loners) expect(held.has(id), `"${id}" fits nowhere but was put in a topic`).toBe(false);
  });

  it('every topic is well formed', () => {
    expectWellFormed(topics, lib.docs);
  });

  it('a group of ten and a group of six both come out whole', () => {
    const docs = [...cloud('big', 4, 10, 11), ...cloud('small', 5, 6, 12), makeDoc('lone', scatter(axisVector(DIM, 12), 0.1, seeded(13)))];
    const found = clusterTopics(docs);
    expect(found, describeTopics(found)).toHaveLength(2);
    expect(sortedIds(topicHolding(found, 'big1').docIds)).toEqual(sortedIds(docs.filter((d) => d.id.startsWith('big')).map((d) => d.id)));
    expect(sortedIds(topicHolding(found, 'small1').docIds)).toEqual(sortedIds(docs.filter((d) => d.id.startsWith('small')).map((d) => d.id)));
  });

  it('a doc with an all-zero vector (no meaning to compare) stays out and does not disturb the rest', () => {
    const docs = [...buildLibrary().docs, makeDoc('empty', new Float32Array(DIM))];
    const found = clusterTopics(docs);
    expectGroupsFound(lib, found);
    expect(found.flatMap((t) => t.docIds)).not.toContain('empty');
  });

  it('works when every doc has empty text', () => {
    const docs = buildLibrary().docs.map((d) => makeDoc(d.id, d.vector));
    const found = clusterTopics(docs);
    expectGroupsFound(lib, found);
    expectWellFormed(found, docs);
  });

  it(
    'a library of 260 docs with real-sized (384) vectors: six groups of 40 and 20 loners',
    () => {
      const dim = 384;
      const rand = seeded(21);
      const docs: Doc[] = [];
      const members: string[][] = [];
      for (let g = 0; g < 6; g++) {
        members.push([]);
        for (let i = 0; i < 40; i++) {
          const id = `g${g}-${i}`;
          docs.push(makeDoc(id, scatter(axisVector(dim, g), NOISE, rand)));
          members[g].push(id);
        }
      }
      for (let l = 0; l < 20; l++) docs.push(makeDoc(`lone${l}`, scatter(axisVector(dim, 10 + l), NOISE, rand)));
      const t0 = performance.now();
      const found = clusterTopics(docs);
      const ms = performance.now() - t0;
      expect(found, describeTopics(found)).toHaveLength(6);
      for (const ids of members) expect(sortedIds(topicHolding(found, ids[0]).docIds)).toEqual(sortedIds(ids));
      expect(found.flatMap((t) => t.docIds).some((id) => id.startsWith('lone'))).toBe(false);
      expect(ms, `took ${ms.toFixed(0)} ms`).toBeLessThan(10_000);
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------------------------------------------------
describe('clusterTopics: the same input in any order gives the same topics', () => {
  const lib = buildLibrary();
  const base = clusterTopics(lib.docs);

  it('the base answer is the one we expect (so the checks below compare something real)', () => {
    expect(base).toHaveLength(3);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('shuffle %i: same keys, members and names', (seed) => {
    const answer = clusterTopics(shuffled(lib.docs, seed));
    expect(canon(answer)).toEqual(canon(base));
  });

  it('reversed and sorted by id, descending', () => {
    expect(canon(clusterTopics([...lib.docs].reverse()))).toEqual(canon(base));
    expect(canon(clusterTopics([...lib.docs].sort((a, b) => byCodeUnit(b.id, a.id))))).toEqual(canon(base));
  });

  it('the same call twice gives the same answer', () => {
    expect(clusterTopics(lib.docs)).toEqual(base);
  });

  it('the docs are left as they were (order, ids, vectors, text)', () => {
    const docs = shuffled(lib.docs, 99);
    const before = snapshot(docs);
    clusterTopics(docs);
    expect(snapshot(docs)).toBe(before);
  });

  it('guess: even the raw answer is the same (order of topics and of members), not just the same sets', () => {
    expect(clusterTopics(shuffled(lib.docs, 5))).toEqual(clusterTopics(shuffled(lib.docs, 6)));
    expect(clusterTopics([...lib.docs].reverse())).toEqual(clusterTopics(lib.docs));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('clusterTopics: the key is stable for the same member set (T4)', () => {
  const lib = buildLibrary();
  const base = clusterTopics(lib.docs);
  const keyOfGroup = (topics: readonly Topic[], prefix: string): string => topicHolding(topics, `${prefix}1`).key;

  it('different topics have different keys', () => {
    expect(new Set(base.map((t) => t.key)).size).toBe(3);
  });

  it('same members, vectors drawn again and texts rewritten: same key for each topic', () => {
    const again = buildLibrary({ seed: 2, traps: ALL_TRAPS });
    const found = clusterTopics(again.docs);
    expectGroupsFound(again, found);
    for (const prefix of Object.keys(lib.groups)) expect(keyOfGroup(found, prefix), `topic "${prefix}"`).toBe(keyOfGroup(base, prefix));
  });

  it('a new loner arrives: every existing topic keeps its key and its members', () => {
    const withLoner = [...lib.docs, makeDoc('x9', scatter(axisVector(DIM, 13), NOISE, seeded(5)), 'Cheese', 'Maturing cheese in caves')];
    const found = clusterTopics(withLoner);
    expect(canon(found).map(({ key, docIds }) => ({ key, docIds }))).toEqual(canon(base).map(({ key, docIds }) => ({ key, docIds })));
  });

  it('one group is swapped for another set of docs: the other two topics keep their keys', () => {
    const swapped = [...lib.docs.filter((d) => !d.id.startsWith('c')), ...cloud('n', 6, 6, 77, NOISE)];
    const found = clusterTopics(swapped);
    expect(keyOfGroup(found, 'a')).toBe(keyOfGroup(base, 'a'));
    expect(keyOfGroup(found, 'b')).toBe(keyOfGroup(base, 'b'));
    expect(found).toHaveLength(3);
  });

  it('keys do not depend on the order docs arrive in', () => {
    const found = clusterTopics(shuffled(lib.docs, 42));
    for (const prefix of Object.keys(lib.groups)) expect(keyOfGroup(found, prefix)).toBe(keyOfGroup(base, prefix));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('clusterTopics: names', () => {
  const MIDDLE_DOT = '·';
  const parts = (name: string): string[] => name.split(` ${MIDDLE_DOT} `);
  const wordsOf = (name: string): string[] => parts(name).flatMap((p) => p.split(' '));
  const variants: Array<[string, Parameters<typeof buildLibrary>[0]]> = [
    ['plain text', {}],
    ['library-wide words (analysis, data, results) used more often than the telling words', { traps: { sharedHeavy: true } }],
    ['stop words that only this group uses (between, which, their ...)', { traps: { leanStops: true } }],
    ['a year and a number that only this group uses', { traps: { numbers: true } }],
    ['all three traps at once', { traps: ALL_TRAPS }],
    ['titles only (no abstracts)', { titleOnly: true }],
    ['another seed (other vectors, other upper and lower case)', { seed: 3, traps: ALL_TRAPS }],
  ];

  const names = (opts: Parameters<typeof buildLibrary>[0]): { lib: Library; topics: Topic[] } => {
    const lib = buildLibrary(opts);
    const topics = clusterTopics(lib.docs);
    expectGroupsFound(lib, topics);
    return { lib, topics };
  };

  it.each(variants)('the two telling words of each topic: %s', (_name, opts) => {
    const { lib, topics } = names(opts);
    for (const s of GROUPS) {
      const name = topicHolding(topics, lib.groups[s.prefix][0]).name;
      expect(new Set(wordsOf(name).map((w) => w.toLowerCase())), `name of the "${s.prefix}" topic is "${name}"`).toEqual(new Set(s.tell));
    }
  });

  it('format: two parts joined by " · ", every word in Title Case, no digits (T5)', () => {
    const { topics } = names({ traps: ALL_TRAPS });
    for (const t of topics) {
      expect(parts(t.name), `name "${t.name}"`).toHaveLength(2);
      for (const w of wordsOf(t.name)) expect(w, `word "${w}" in "${t.name}"`).toMatch(/^\p{Lu}[\p{Ll}'-]*$/u);
      expect(t.name).not.toMatch(/\d/);
    }
  });

  it('format by the interface: one word on each side, and not the same word twice', () => {
    const { topics } = names({ traps: ALL_TRAPS });
    for (const t of topics) {
      const p = parts(t.name);
      expect(p.every((w) => !w.includes(' ')), `name "${t.name}"`).toBe(true);
      expect(p[0].toLowerCase()).not.toBe(p[1].toLowerCase());
    }
  });

  it('the words are matched without regard to case and come out in Title Case, though the texts mix lower, upper and title case (T8)', () => {
    const { lib, topics } = names({ seed: 3, traps: ALL_TRAPS });
    const a = topicHolding(topics, lib.groups.a[0]).name;
    expect(['Inflation · Monetary', 'Monetary · Inflation'], `name is "${a}"`).toContain(a);
  });

  it('the three topics get three different names', () => {
    const { topics } = names({});
    expect(new Set(topics.map((t) => t.name)).size).toBe(3);
  });

  it('a library-wide word is never chosen over a telling one (analysis, data, results)', () => {
    const { topics } = names({ traps: { sharedHeavy: true } });
    for (const t of topics) for (const w of wordsOf(t.name)) expect(SHARED, `"${t.name}"`).not.toContain(w.toLowerCase());
  });

  it('stop words and numbers are never in a name (T7)', () => {
    const { topics } = names({ traps: ALL_TRAPS });
    const banned = new Set([...COMMON_STOPS.map(([w]) => w), ...GROUPS.flatMap((s) => [...s.lean, s.number, s.small])]);
    for (const t of topics) for (const w of wordsOf(t.name)) expect(banned, `"${t.name}"`).not.toContain(w.toLowerCase());
  });

  it('names come from the members: a topic of the same vectors with other texts is named for those texts', () => {
    const lib = buildLibrary();
    const a = lib.groups.a;
    const retitled = lib.docs.map((d) => (a.includes(d.id) ? makeDoc(d.id, d.vector, 'Sourdough fermentation starter', 'sourdough sourdough fermentation fermentation crumb') : d));
    const found = clusterTopics(retitled);
    const name = topicHolding(found, 'a1').name;
    expect(new Set(wordsOf(name).map((w) => w.toLowerCase())), `name is "${name}"`).toEqual(new Set(['sourdough', 'fermentation']));
  });
});
