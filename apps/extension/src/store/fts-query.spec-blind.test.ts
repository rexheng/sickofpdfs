// Spec-blind table tests for the full-text query builder (Phase 3, pack T3): what the Ctrl+K box and the library's search box turn
// into the one string that is handed to SQLite's `MATCH`.
//
// Sources: spec "One search box (Ctrl+K)" (titles, authors, full page text, figure captions, notes and Claude's replies; "ranked
// by relevance with highlighted snippets"), "Storage" (SQLite FTS5), contracts section 5 (`search(...)` "FTS terms quoted, never
// raw MATCH"; snippets keep `<b>` markers), the shared rule that PDF text is untrusted, the plan's "Test packs" (the FTS query
// builder: quotes, operators, prefix, unicode, over-long input), CLAUDE.md ("plain, clear wording"; the owner has learning
// disabilities: a search must not break on what they type or paste).
//
// How the tests read the builder: they build a real FTS5 table with the same tokenizer the store uses (`unicode61 remove_diacritics
// 2`, schema.ts) in Node's own SQLite, run the builder's string through `MATCH`, and look at which rows come back. So the tests
// never depend on how the string is spelled, only on what SQLite does with it: whether it throws, and what it finds.
//
// GUESSES (the contract names the module `fts-query` and the rule, nothing else): the function is called `ftsQuery` (the name the
// store already has for its Phase 1 version), takes the text the person typed and returns a string or null; prefix matching
// for search-as-you-type is asked for with a second argument `{ prefix: true }` and applies to the last word.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import * as ftsModule from './fts-query';

// ---------------------------------------------------------------------------------------------------------------
// Calling the builder

type BuildFn = (text: string, options?: unknown) => unknown;
const NAMES = ['ftsQuery', 'buildFtsQuery', 'toFtsQuery', 'ftsMatch', 'toMatch', 'matchQuery', 'buildMatch', 'buildQuery'];
const PREFIX_NAMES = ['ftsPrefixQuery', 'prefixQuery', 'ftsQueryPrefix', 'buildPrefixQuery'];

function pick(names: readonly string[]): BuildFn | undefined {
  const m = ftsModule as Record<string, unknown>;
  for (const n of names) if (typeof m[n] === 'function') return m[n] as BuildFn;
  return undefined;
}

const toMatch = (r: unknown): string | null => {
  if (r === null || r === undefined) return null;
  if (typeof r === 'string') return r.trim() === '' ? null : r;
  const o = r as Record<string, unknown>;
  for (const k of ['match', 'query', 'fts', 'text']) if (typeof o[k] === 'string') return toMatch(o[k]);
  throw new Error(`the builder returned something that is neither a string nor null: ${JSON.stringify(r)}`);
};

function build(text: string, prefix = false): string | null {
  const plain = pick(NAMES);
  if (!plain) throw new Error(`fts-query exports none of [${NAMES.join(', ')}]; it exports: ${Object.keys(ftsModule).join(', ') || 'nothing'}`);
  if (!prefix) return toMatch(plain(text));
  const separate = pick(PREFIX_NAMES);
  if (separate) return toMatch(separate(text));
  const viaOptions = toMatch(plain(text, { prefix: true }));
  return viaOptions;
}

// ---------------------------------------------------------------------------------------------------------------
// The oracle: SQLite itself, with the store's tokenizer

const TOKENIZER = `tokenize="unicode61 remove_diacritics 2"`;

function pagesIndex(texts: readonly string[]) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE VIRTUAL TABLE p USING fts5(text, ${TOKENIZER})`);
  const insert = db.prepare('INSERT INTO p (text) VALUES (?)');
  for (const t of texts) insert.run(t);
  const select = db.prepare('SELECT rowid FROM p WHERE p MATCH ? ORDER BY rowid');
  /** The indexes of the pages that match. Throws if SQLite rejects the string, which is the failure we are looking for. */
  return (match: string): number[] => (select.all(match) as { rowid: number }[]).map((r) => r.rowid - 1);
}

/** What a search for `text` finds among `texts`: none when the builder says there is nothing to search for. */
function find(texts: readonly string[], text: string, prefix = false): number[] {
  const match = build(text, prefix);
  return match === null ? [] : pagesIndex(texts)(match);
}

const PAGES = ['the quick brown fox', 'a second page about trends', 'last page'];
const anyIndex = pagesIndex(PAGES);

// ---------------------------------------------------------------------------------------------------------------

interface Row {
  name: string;
  query: string;
  pages: string[];
  /** Exactly these pages match. */
  exact?: number[];
  /** At least these pages match. */
  includes?: number[];
  /** None of these match. */
  excludes?: number[];
}

describe('words', () => {
  const rows: Row[] = [
    { name: 'every word has to be on the page, in any order', query: 'parallel trends', pages: ['trends hold if parallel', 'only parallel', 'only trends', 'neither'], exact: [0] },
    { name: 'case does not matter', query: 'PARALLEL Trends', pages: ['parallel trends', 'trends'], exact: [0] },
    { name: 'a typed accent finds the plain letter', query: 'Schrödinger', pages: ['Schrodinger equation', 'other'], exact: [0] },
    { name: 'a plain letter finds the accented one', query: 'Schrodinger', pages: ['Schrödinger equation', 'other'], exact: [0] },
    { name: 'Chinese', query: '数据', pages: ['数据 分析', '分析'], exact: [0] },
    { name: 'Greek', query: 'αβγ', pages: ['δ αβγ ε', 'δ ε'], exact: [0] },
    { name: 'Cyrillic, whatever the case', query: 'Привет', pages: ['привет мир', 'мир'], exact: [0] },
    { name: 'a hyphenated word finds it with or without the hyphens', query: 'state-of-the-art', pages: ['a state of the art method', 'state', 'art'], exact: [0] },
    { name: 'a DOI', query: '10.1257/aer.20180779', pages: ['doi 10.1257/aer.20180779 end', '10.1257', 'aer'], exact: [0] },
    { name: 'a number with a decimal point', query: '3.14', pages: ['pi is 3.14 roughly', '3 and 14', 'pi'], exact: [0] },
    { name: 'an apostrophe, straight in the box and curly in the PDF', query: "Schrödinger's", pages: ['Schrödinger’s cat', 'Schrodinger cat'], exact: [0] },
    { name: 'a dash or symbol standing alone between words is ignored', query: 'parallel — trends & …', pages: ['parallel trends hold', 'trends only'], exact: [0] },
    { name: 'a phrase in quotes still finds the page that has it', query: '"parallel trends"', pages: ['parallel trends hold', 'trends only'], includes: [0], excludes: [1] },
    { name: 'tabs, line breaks, no-break and ideographic spaces all separate words', query: ' parallel \t\n trends hold　now ', pages: ['now hold trends parallel', 'parallel'], exact: [0] },
  ];
  it.each(rows)('$name', ({ query, pages, exact, includes, excludes }) => {
    const found = find(pages, query);
    if (exact) expect(found).toEqual(exact);
    if (includes) for (const i of includes) expect(found).toContain(i);
    if (excludes) for (const i of excludes) expect(found).not.toContain(i);
  });

  it('words may be in different columns of a document (title and authors) and still match together', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE VIRTUAL TABLE d USING fts5(title, authors, ${TOKENIZER})`);
    db.prepare('INSERT INTO d (title, authors) VALUES (?, ?)').run('Analytical plan', 'Ada Lovelace');
    db.prepare('INSERT INTO d (title, authors) VALUES (?, ?)').run('Another plan', 'Someone Else');
    const hits = (text: string) => (db.prepare('SELECT rowid FROM d WHERE d MATCH ?').all(build(text) ?? '""') as { rowid: number }[]).map((r) => r.rowid);
    expect(hits('lovelace plan')).toEqual([1]);
    expect(hits('else plan')).toEqual([2]);
  });
});

describe('FTS operators typed into the box are words, not operators', () => {
  const rows: Row[] = [
    { name: 'OR does not widen the search', query: 'cats OR dogs', pages: ['cats or dogs', 'cats only', 'dogs only'], exact: [0] },
    { name: 'AND does not change it either', query: 'cats AND dogs', pages: ['cats and dogs', 'cats only', 'dogs bark'], exact: [0] },
    { name: 'NOT does not exclude (and is not a syntax error)', query: 'cats NOT dogs', pages: ['cats and dogs', 'cats only', 'cats not dogs'], excludes: [1] },
    { name: 'NEAR( ) is not the proximity operator', query: 'NEAR(cats dogs)', pages: ['cats and dogs', 'near cats dogs'], excludes: [0] },
    { name: 'a leading dash does not turn a word into an exclusion or an error', query: '-dogs', pages: ['dogs bark', 'cats'], excludes: [1] },
  ];
  it.each(rows)('$name', ({ query, pages, exact, excludes }) => {
    const found = find(pages, query);
    if (exact) expect(found).toEqual(exact);
    if (excludes) for (const i of excludes) expect(found).not.toContain(i);
  });

  it('a column name before a colon is not a column filter', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE VIRTUAL TABLE d USING fts5(title, authors, ${TOKENIZER})`);
    db.prepare('INSERT INTO d (title, authors) VALUES (?, ?)').run('plan', 'smith');
    const hits = (text: string) => (db.prepare('SELECT rowid FROM d WHERE d MATCH ?').all(build(text) ?? '""') as { rowid: number }[]).map((r) => r.rowid);
    expect(hits('authors:smith')).toEqual([]);
    expect(hits('title:plan')).toEqual([]);
    expect(hits('nosuchcolumn:smith')).toEqual([]);
  });
});

// Anything a person can type or paste. None of it may reach SQLite as syntax: each string must run, never throw.
const HOSTILE = [
  '"', '""', '"""', '""""', 'say "hello', 'say "hello world"', '"a" "b"', 'a"b', 'rock"n"roll', "it's", '“smart” ‘quotes’', '\\', '\\"', '"\\"',
  '(', ')', '()', '(a', 'a)', '((a b)', '(a OR b) AND (c', 'a OR', 'OR', 'AND', 'NOT', 'a NOT', 'NOT a', 'NEAR', 'NEAR(', 'NEAR(a b, 3)', 'NEAR/3 a b',
  '*', 'a*', '*a', '**', 'a**', '^', '^a', '-', '-a', '--', '+', '+a', ':', 'a:', ':a', 'title:', 'text:a', '{text}: a', '{', '}', ',', ';',
  "'; DROP TABLE p; --", '/* c */', '<script>alert(1)</script>', 'a|b', 'a&b', 'a=b', '%', '_', '~', '`', '#', '@', '[a]', '$1', '‮ abc', '\uD800', '𝔘𝔫𝔦𝔠𝔬𝔡𝔢',
  'é', '🙂 trends', 'c++', 'C#', 'a.b.c', "O'Brien", '10.1257/aer.20180779', 'http://example.org/a?b=c&d=e#f',
];

describe('anything typed or pasted runs without a syntax error', () => {
  it('every string in a long list of hostile ones builds a query that SQLite accepts, plain and with prefix', () => {
    const failures: string[] = [];
    for (const text of HOSTILE) {
      for (const prefix of [false, true]) {
        try {
          const match = build(text, prefix);
          if (match !== null) anyIndex(match);
        } catch (e) {
          failures.push(`${prefix ? 'prefix' : 'plain'} ${JSON.stringify(text)}: ${(e as Error).message}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('every string it builds is made of quoted words only: nothing the person typed is left outside quotes', () => {
    const PHRASE = /"(?:[^"]|"")*"\*?/g;
    const failures: string[] = [];
    for (const text of HOSTILE) {
      for (const prefix of [false, true]) {
        const match = build(text, prefix);
        if (match === null) continue;
        const rest = match.replace(PHRASE, '');
        if (!/^[\s()]*(?:(?:AND|OR|NOT)[\s()]*)*$/.test(rest)) failures.push(`${prefix ? 'prefix' : 'plain'} ${JSON.stringify(text)} -> ${JSON.stringify(match)} (left outside quotes: ${JSON.stringify(rest)})`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('nothing to search for', () => {
  const empties = ['', '   ', '\n\t', '"', '""', '...', '---', '!!!', '()', '*', '🙂', '🙂🙂', '—', '“”', ' " * ( ) '];
  it('text with no letter or digit in it finds nothing, rather than everything, and does not throw', () => {
    const failures: string[] = [];
    for (const text of empties) {
      for (const prefix of [false, true]) {
        try {
          const found = find(PAGES, text, prefix);
          if (found.length > 0) failures.push(`${prefix ? 'prefix' : 'plain'} ${JSON.stringify(text)} found pages ${found.join(', ')}`);
        } catch (e) {
          failures.push(`${prefix ? 'prefix' : 'plain'} ${JSON.stringify(text)}: ${(e as Error).message}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('prefix matching, for search as you type', () => {
  const pages = ['parallel trends hold', 'trending topics', 'trendy shoes', 'unrelated', 'Schrödinger'];
  const rows: [string, string, number[]][] = [
    ['the last word may be unfinished', 'tren', [0, 1, 2]],
    ['and the finished words before it still count whole', 'parallel tren', [0]],
    ['it folds accents like the index does', 'Schro', [4]],
    ['one letter is allowed', 'u', [3]],
  ];
  it.each(rows)('%s: "%s"', (_name, query, expected) => {
    expect(find(pages, query, true)).toEqual(expected);
  });

  it('GUESS: without the prefix option a word is a whole word', () => {
    expect(find(pages, 'tren')).toEqual([]);
    expect(find(pages, 'trends')).toEqual([0]);
  });
});

describe('over-long input', () => {
  const quotedWords = (m: string): number => (m.match(/"(?:[^"]|"")*"/g) ?? []).length;
  const big: [name: string, text: string][] = [
    ['20,000 different words (a pasted page)', Array.from({ length: 20_000 }, (_, i) => `word${i}`).join(' ')],
    ['one word of 200,000 letters', 'a'.repeat(200_000)],
    ['100,000 quote marks', '"'.repeat(100_000)],
    ['50,000 operators and brackets', 'AND OR NOT NEAR ( ) " * ^ : '.repeat(5_000)],
    ['100,000 Chinese characters', '数'.repeat(100_000)],
  ];

  it.each(big)('%s: quick, bounded, and still valid', (_name, text) => {
    const t0 = performance.now();
    const match = build(text);
    const took = performance.now() - t0;
    expect(took, 'building the query takes a moment, not seconds').toBeLessThan(250);
    if (match !== null) {
      expect(match.length, 'the query is cut to a sane length').toBeLessThanOrEqual(4_000);
      expect(quotedWords(match), 'and to a sane number of words').toBeLessThanOrEqual(100);
      expect(() => anyIndex(match)).not.toThrow();
    }
  });

  it('keeps the start of a long query, which is what the person was looking for', () => {
    const match = build(`parallel trends ${'filler '.repeat(5_000)}`) ?? '';
    expect(match).toContain('parallel');
    expect(match).toContain('trends');
  });
});

describe('a plain function', () => {
  it('gives the same string for the same text, and an equivalent one whatever the spacing', () => {
    expect(build('parallel  trends')).toBe(build('parallel trends'));
    expect(build(' parallel trends\n')).toBe(build('parallel trends'));
    expect(build('parallel trends')).toBe(build('parallel trends'));
  });
});

describe('random input', () => {
  // A fixed generator, so a failure is the same failure next time. 400 strings, built from the pieces that are syntax in FTS5,
  // some words, and a few scripts.
  function mulberry32(a: number) {
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const PIECES = ['"', '""', "'", '(', ')', '*', '^', '-', '+', ':', 'AND', 'OR', 'NOT', 'NEAR', 'NEAR/3', 'title:', 'text:', '{', '}', ',', '\\', ';', '--', '/*', 'é', '数', 'ß', '🙂', 'a', 'trends', 'Parallel', '0', '%', '_', '.', '#', '@', '[', ']', '<', '>', '|', '&', '=', '~', '`', ' ', '\t', '\n'];

  it('400 random strings: each one builds a query that SQLite accepts, and that is only quoted words', () => {
    const rnd = mulberry32(20261102);
    const PHRASE = /"(?:[^"]|"")*"\*?/g;
    for (let n = 0; n < 400; n++) {
      const len = 1 + Math.floor(rnd() * 14);
      let text = '';
      for (let i = 0; i < len; i++) text += PIECES[Math.floor(rnd() * PIECES.length)] + (rnd() < 0.5 ? ' ' : '');
      for (const prefix of [false, true]) {
        const match = build(text, prefix);
        if (match === null) continue;
        expect(() => anyIndex(match), `${JSON.stringify(text)} -> ${JSON.stringify(match)}`).not.toThrow();
        expect(match.replace(PHRASE, ''), `${JSON.stringify(text)} -> ${JSON.stringify(match)}`).toMatch(/^[\s()]*(?:(?:AND|OR|NOT)[\s()]*)*$/);
      }
    }
  });
});
