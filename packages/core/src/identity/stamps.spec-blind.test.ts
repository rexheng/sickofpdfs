// Spec-blind tests for download-stamp stripping and alias similarity (Task 19).
//
// Sources (the spec, "Library and knowledge base", and the interface file only):
//   identity rule 2: "Same text, new bytes = still the same document. Many sites stamp each download (JSTOR prints 'This
//     content downloaded from <IP> on <date>' on every page). If new bytes have the same page count and their page text
//     matches a known document at 99.5% or more after stamp lines, IP addresses and dates are removed, the new fingerprint
//     becomes an alias: same notes, nothing copied."
//   identity rule 3: "A genuinely different file is a different document."
//   interface goal: "only a near-identical text match with the stamp pages removed may alias. A different edition, a different
//     preprint version (arXiv v1 vs v2) or a different chapter must never alias, and when unsure, do not alias. Page text
//     arrives from PDFium with U+FFFE/U+FFFF marks and line breaks that differ between copies; matching folds whitespace
//     and ligatures the same way the anchoring code does."
//   interface signatures: ALIAS_THRESHOLD = 0.995; stripStamps(pageText): string; stampedTextSimilarity(a, b): number, "0 when
//     page counts differ"; the score is "1 - sum(levenshtein) / sum(max(lenA, lenB))" after stripping, "0 when the total
//     stripped lengths differ by more than 0.5%".
//
// Real text: five pages of a CC BY paper and two five-page runs of a GFDL textbook (packages/core/test/spec-blind/
// stamps-real-pages.ts). The stamps are written the way the sites print them. Every stamp row is run in both argument orders:
// a note's document must not depend on which copy was seen first.
//
// Where the spec is silent these tests guess; each guess is marked "GUESS" and listed in the report.
import { describe, expect, it } from 'vitest';
import { foldText } from '../anchoring/text-fold';
import { BOOK_EARLY, BOOK_LATE, PAPER } from '../../test/spec-blind/stamps-real-pages';
import { ALIAS_THRESHOLD, stampedTextSimilarity, stripStamps } from './stamps';

type Pages = readonly string[];

// ---------------------------------------------------------------------------------------------------------------
// Page text, the way PDFium returns it

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const folded = (pages: Pages): string[] => pages.map((p) => foldText(p).text);
const foldedLength = (pages: Pages): number => folded(pages).reduce((n, p) => n + p.length, 0);

interface Layout {
  /** Characters per line. */
  width: number;
  /** What ends a line. ' ' means the page has no line breaks at all. */
  eol: '\r\n' | '\n' | ' ';
  /** U+FFFE inside some words and after line-end hyphens; U+FFFF after some words. */
  marks?: boolean;
  /** Double spaces, non-breaking spaces and a trailing space on some lines. */
  oddSpaces?: boolean;
}

const PDFIUM: Layout = { width: 78, eol: '\r\n' };

/** Lays the words of `text` out again. Only whitespace and the marks that are not text change; the folded text does not. */
function layout(text: string, o: Layout = PDFIUM): string {
  const words = collapse(text).split(' ');
  const lines: string[] = [];
  let line = '';
  const flush = () => {
    let l = line;
    if (o.marks && l.endsWith('-')) l += '￾'; // PDFium marks a line-end hyphen it joins
    if (o.oddSpaces && lines.length % 4 === 1) l += ' ';
    lines.push(l);
  };
  words.forEach((word, i) => {
    let w = word;
    if (o.marks && i % 31 === 11 && w.length > 3) w = `${w.slice(0, 2)}￾${w.slice(2)}`;
    if (o.marks && i % 23 === 7) w += '￿';
    const sep = o.oddSpaces ? (i % 9 === 0 ? '  ' : i % 5 === 0 ? ' ' : ' ') : ' ';
    if (line && line.length + 1 + w.length > o.width) {
      flush();
      line = w;
    } else line = line ? line + sep + w : w;
  });
  if (line) flush();
  return lines.join(o.eol);
}

interface CopyOptions {
  layout?: Layout;
  /** Lines printed above the text of every page. */
  header?: string;
  /** Lines printed below the text of every page. */
  footer?: string;
}

/** A downloaded copy: the real pages laid out, each with its stamp lines. */
function copyOf(pages: Pages, o: CopyOptions = {}): string[] {
  return pages.map((p) => [o.header, layout(p, o.layout), o.footer].filter((s): s is string => s !== undefined).join('\r\n'));
}

// ---------------------------------------------------------------------------------------------------------------
// Stamps as the sites print them

const jstorNew = (ip: string, when: string) =>
  `This content downloaded from ${ip} on ${when}\r\nAll use subject to https://about.jstor.org/terms`;
const jstorOld = (ip: string, when: string) =>
  `This content downloaded from ${ip} on ${when}\r\nAll use subject to JSTOR Terms and Conditions`;
const oupWatermark = (who: string, when: string) =>
  `Downloaded from https://academic.oup.com/jnci/article/99/10/815/2521983 by ${who} on ${when}`;
const tandf = (library: string, at: string, when: string) => `Downloaded by [${library}] at ${at} ${when}`;

const JSTOR_A = jstorNew('128.59.222.107', 'Tue, 03 Mar 2015 14:22:11 UTC');
const JSTOR_B = jstorNew('203.0.113.45', 'Fri, 17 Nov 2023 08:05:59 UTC');

/** A university library's cover sheet: one extra page in front of the article. */
const LIBRARY_COVER = [
  'University of Melbourne Library',
  'Course reading: ECON2020 Week 3',
  'Downloaded by [University of Melbourne] at 14:50 07 August 2023',
  'This material has been copied and communicated to you under licence. Further copying or communication of this material by you may be the subject of copyright protection.',
].join('\r\n');

// ---------------------------------------------------------------------------------------------------------------
// Edits that turn a paper into another version of itself. All keep the page count; the first two keep the length too.

function editOnce(pages: Pages, pageIndex: number, from: string, to: string): string[] {
  const out = [...pages];
  const c = collapse(out[pageIndex]);
  if (!c.includes(from)) throw new Error(`fixture changed: "${from}" is not on page ${pageIndex + 1}`);
  out[pageIndex] = c.replace(from, to);
  return out;
}

/** Replaces `len` chars of a page, from the first word boundary after `near`, with the first `len` chars of `source`. */
function replaceWindow(pages: Pages, pageIndex: number, near: number, len: number, source: string): string[] {
  const out = [...pages];
  const c = collapse(out[pageIndex]);
  const start = c.indexOf(' ', near) + 1;
  // No space at either edge of the new text, so the length stays exactly `len` once whitespace is folded.
  const repl = source.slice(0, len).replace(/^ /, 'x').replace(/ $/, 'x');
  out[pageIndex] = c.slice(0, start) + repl + c.slice(start + len);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Row runners. Every pair is scored in both orders.

interface Row {
  name: string;
  a: Pages;
  b: Pages;
  /** Stripped of stamps the two copies are word for word the same, so the score is exactly 1. */
  exactlyOne?: boolean;
}

function scoresBothWays(r: Row): number[] {
  return [stampedTextSimilarity(r.a, r.b), stampedTextSimilarity(r.b, r.a)];
}

// ===============================================================================================================
describe('same text under a different stamp aliases (identity rule 2)', () => {
  const rows: Row[] = [
    {
      name: 'JSTOR: other IP and date at the foot of every page, same words',
      a: copyOf(PAPER, { footer: JSTOR_A }),
      b: copyOf(PAPER, { footer: JSTOR_B }),
      exactlyOne: true,
    },
    {
      name: 'a publisher watermark line on every page vs the clean copy (a stamp is the only difference)',
      a: copyOf(PAPER, { header: oupWatermark('guest', '03 June 2022') }),
      b: copyOf(PAPER),
      exactlyOne: true,
    },
    {
      name: '"Downloaded by [library] at time date" on every page, two libraries',
      a: copyOf(PAPER, { header: tandf('University of Toronto', '06:31', '24 March 2015') }),
      b: copyOf(PAPER, { header: tandf('University of Melbourne', '14:50', '07 August 2023') }),
    },
    {
      // GUESS (likely to disagree): the old JSTOR terms line ("All use subject to JSTOR Terms and Conditions") is a stamp line too.
      name: 'JSTOR 2013 stamp (AM/PM time, "JSTOR Terms and Conditions") vs a JSTOR 2023 stamp',
      a: copyOf(PAPER, { footer: jstorOld('129.2.19.102', 'Thu, 22 Aug 2013 05:11:55 AM') }),
      b: copyOf(PAPER, { footer: JSTOR_B }),
    },
  ];

  it.each(rows)('$name', (r) => {
    for (const score of scoresBothWays(r)) {
      expect(score).toBeGreaterThanOrEqual(ALIAS_THRESHOLD);
      expect(score).toBeLessThanOrEqual(1);
      if (r.exactlyOne) expect(score).toBe(1);
    }
  });
});

// ===============================================================================================================
describe('the same paper extracted differently still aliases (PDFium marks and line breaks)', () => {
  const noisy: Layout = { width: 78, eol: '\r\n', marks: true };
  const plainLf: Layout = { width: 64, eol: '\n', oddSpaces: true };
  const oneLine: Layout = { width: 78, eol: ' ', marks: true };
  // Every ligature the merged fold knows (U+FB00 to U+FB06): ff, fi, fl, ffi, ffl and st. "st" is common enough that an
  // unfolded copy would be well over 0.5% different in length and in letters.
  const ligatures = (p: string) =>
    collapse(p)
      .replace(/ffi/g, '\uFB03')
      .replace(/ffl/g, '\uFB04')
      .replace(/ff/g, '\uFB00')
      .replace(/fi/g, '\uFB01')
      .replace(/fl/g, '\uFB02')
      .replace(/st/g, '\uFB06');

  const rows: Row[] = [
    {
      name: 'other line width, LF instead of CR LF, odd spaces, vs U+FFFE/U+FFFF marks (no stamps at all)',
      a: copyOf(PAPER, { layout: noisy }),
      b: copyOf(PAPER, { layout: plainLf }),
    },
    {
      name: 'a page with no line breaks at all (and marks) vs a hard-wrapped page',
      a: copyOf(BOOK_EARLY, { layout: oneLine }),
      b: copyOf(BOOK_EARLY, { layout: { width: 50, eol: '\r\n' } }),
    },
    {
      name: 'marks and line breaks differ AND the stamp differs',
      a: copyOf(PAPER, { layout: noisy, footer: JSTOR_A }),
      b: copyOf(PAPER, { layout: plainLf, footer: JSTOR_B }),
    },
    {
      // GUESS (likely to disagree): marks may also sit at the edges of a stamp line, and a stamp line is still a stamp line.
      name: 'a U+FFFF in front of the JSTOR line and a U+FFFE after the terms line',
      a: copyOf(PAPER, { footer: `\uFFFF${JSTOR_A}` }),
      b: copyOf(PAPER, { footer: `${JSTOR_B}\uFFFE` }),
    },
    {
      name: 'ligature characters (ff, fi, fl, ffi, ffl, st) in one copy, plain letters in the other',
      a: copyOf(PAPER.map(ligatures)),
      b: copyOf(PAPER),
    },
  ];

  it('test data check: the unstamped variants fold to exactly the same words', () => {
    // Guards the rows above against a mistake in this file's own layout helper. The oracle is the merged anchoring fold.
    expect(folded(copyOf(PAPER, { layout: noisy }))).toEqual(folded(copyOf(PAPER, { layout: plainLf })));
    expect(folded(copyOf(BOOK_EARLY, { layout: oneLine }))).toEqual(folded(copyOf(BOOK_EARLY)));
    expect(folded(copyOf(PAPER.map(ligatures)))).toEqual(folded(copyOf(PAPER)));
    // ... and the ligature row really has ligatures in it, enough to matter if they were not folded.
    expect(copyOf(PAPER.map(ligatures)).join('').match(/[\uFB00-\uFB06]/g)?.length ?? 0).toBeGreaterThan(150);
  });

  it.each(rows)('$name', (r) => {
    for (const score of scoresBothWays(r)) {
      expect(score).toBeGreaterThanOrEqual(ALIAS_THRESHOLD);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

// ===============================================================================================================
describe('a different document never aliases (identity rule 3, the safety rule)', () => {
  const v1 = PAPER;
  // arXiv v2 rewrites one 700-character paragraph on page 3 (same length, so only the text comparison can catch it).
  const v2Paragraph = replaceWindow(v1, 2, 2000, 700, collapse(BOOK_EARLY[0]));
  // arXiv v2 corrects three numbers in the abstract.
  const v2Numbers = editOnce(
    editOnce(editOnce(v1, 0, '85% of the aggregate citations', '83% of the aggregate citations'), 0, '(p = 0.006)', '(p = 0.009)'),
    0,
    'a 69% increase in citations',
    'a 71% increase in citations',
  );
  // A later edition rewrites three 150-character passages on every page (about 6% of the text; the length is unchanged).
  let edition2: string[] = [...v1];
  for (let page = 0; page < v1.length; page++) {
    [300, 1500, 3000].forEach((near, k) => {
      edition2 = replaceWindow(edition2, page, near, 150, collapse(BOOK_LATE[(page + k) % 5]).slice(400 * k));
    });
  }

  const exactZero: Row[] = [
    {
      name: 'a library cover page ADDED (6 pages vs 5): page counts differ',
      a: copyOf(PAPER, { footer: JSTOR_A }),
      b: [LIBRARY_COVER, ...copyOf(PAPER, { footer: JSTOR_B })],
    },
    {
      name: 'a library cover page REMOVED (5 pages vs 6): page counts differ',
      a: [LIBRARY_COVER, ...copyOf(PAPER, { footer: JSTOR_B })],
      b: copyOf(PAPER, { footer: JSTOR_A }),
    },
    {
      name: 'same page count but the text of the last page is mostly missing (total length differs by about 10%)',
      a: copyOf(PAPER),
      b: copyOf([...PAPER.slice(0, 4), collapse(PAPER[4]).slice(0, 3200)]),
    },
  ];

  const below: Row[] = [
    {
      name: 'arXiv v2 rewrites a paragraph (v1 is a stamped copy, v2 a clean one)',
      a: copyOf(v1, { footer: JSTOR_A }),
      b: copyOf(v2Paragraph),
    },
    {
      // GUESS (likely to disagree): "A different preprint version (arXiv v1 vs v2) must never alias" is read to cover a version
      // that changes only a few numbers. Three corrected numbers are 6 characters of about 31,000, a score of 0.9998,
      // which a plain 99.5% cut-off would alias.
      name: 'arXiv v2 changes only three numbers in the abstract (85% to 83%, p = 0.006 to 0.009, 69% to 71%)',
      a: copyOf(v1),
      b: copyOf(v2Numbers),
    },
    {
      // GUESS (likely to disagree): as above, and the two copies also carry different stamps.
      name: 'the same three changed numbers, with a different library stamp on each copy',
      a: copyOf(v1, { footer: JSTOR_A }),
      b: copyOf(v2Numbers, { footer: JSTOR_B }),
    },
    {
      name: 'a later edition: about 6% of the text rewritten on every page, same page count and length',
      a: copyOf(v1, { footer: JSTOR_A }),
      b: copyOf(edition2, { footer: JSTOR_B }),
    },
    {
      name: 'a different chapter: same page count, same length, different text, both stamped',
      a: copyOf(BOOK_EARLY, { footer: JSTOR_A }),
      b: copyOf(BOOK_LATE, { footer: JSTOR_B }),
    },
  ];

  it('test data check: the edits keep the page count, the chapters have exactly the same length', () => {
    expect(v2Paragraph).toHaveLength(5);
    expect(v2Numbers).toHaveLength(5);
    expect(edition2).toHaveLength(5);
    expect(foldedLength(BOOK_LATE)).toBe(foldedLength(BOOK_EARLY));
    expect(foldedLength(v2Paragraph)).toBe(foldedLength(v1));
    expect(foldedLength(edition2)).toBe(foldedLength(v1));
  });

  it.each(exactZero)('$name: the score is 0', (r) => {
    expect(scoresBothWays(r)).toEqual([0, 0]);
  });

  it.each(below)('$name', (r) => {
    for (const score of scoresBothWays(r)) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThan(ALIAS_THRESHOLD);
    }
  });
});

// ===============================================================================================================
describe('a scan with (almost) no text never aliases on emptiness alone (GUESS: the spec says only "when unsure, do not alias")', () => {
  const rows: Row[] = [
    { name: 'two blank 120-page scans', a: Array<string>(120).fill(''), b: Array<string>(120).fill('') },
    {
      name: 'two JSTOR scans of different articles: image-only pages, so after the stamp lines are removed nothing is left',
      a: Array<string>(12).fill(JSTOR_A),
      b: Array<string>(12).fill(JSTOR_B),
    },
    {
      name: 'two 40-page scans whose only text is the page number',
      a: Array.from({ length: 40 }, (_, i) => String(i + 1)),
      b: Array.from({ length: 40 }, (_, i) => String(i + 1)),
    },
  ];

  it.each(rows)('$name', (r) => {
    for (const score of scoresBothWays(r)) {
      expect(score).toBeGreaterThanOrEqual(0); // a number, not NaN
      expect(score).toBeLessThan(ALIAS_THRESHOLD);
    }
  });
});

// ===============================================================================================================
describe('the score', () => {
  it('is 1 for the same text on another layout, and ALIAS_THRESHOLD is the spec\'s 99.5%', () => {
    expect(ALIAS_THRESHOLD).toBe(0.995);
    // The textbook pages hold nothing that looks like a date, so no line break can split one (the paper's pages 3 to 5 end in
    // "<page number> March 2007", which reads as a date and may or may not be split by a line break).
    const same = stampedTextSimilarity(copyOf(BOOK_EARLY), copyOf(BOOK_EARLY, { layout: { width: 50, eol: '\n', oddSpaces: true } }));
    expect(same).toBe(1);
  });

  it('is 1 - distance / total length, measured after the stamps are removed', () => {
    // Three one-character substitutions on three pages of the textbook. The copies carry different stamps, which must not count
    // in the length.
    const pages = BOOK_EARLY.map(collapse);
    const hit = (s: string, at: number) => `${s.slice(0, at)}#${s.slice(at + 1)}`;
    const changed = [hit(pages[0], 120), pages[1], hit(pages[2], 1500), pages[3], hit(pages[4], 500)];
    for (const i of [0, 2, 4]) expect(changed[i]).not.toBe(pages[i]);
    const total = pages.reduce((n, p) => n + p.length, 0);
    const a = copyOf(pages, { footer: JSTOR_A });
    const b = copyOf(changed, { footer: JSTOR_B });
    expect(stampedTextSimilarity(a, b)).toBeCloseTo(1 - 3 / total, 6);
    expect(stampedTextSimilarity(b, a)).toBeCloseTo(1 - 3 / total, 6);
  });
});

// ===============================================================================================================
describe('stripStamps', () => {
  const body = PAPER[1]; // page 2 of the paper: no stamp-like text of its own

  describe('removes a whole stamp line, wherever it sits on the page', () => {
    const rows: Array<{ name: string; input: string; expected: string }> = [
      {
        name: 'the two JSTOR lines in the middle of a page',
        input:
          'Opening paragraph ends here.\r\nThis content downloaded from 128.59.222.107 on Tue, 03 Mar 2015 14:22:11 UTC\r\nAll use subject to https://about.jstor.org/terms\r\nSecond paragraph starts here.',
        expected: 'Opening paragraph ends here. Second paragraph starts here.',
      },
      {
        name: '"Downloaded by [library] at <time> <date>" below the text',
        input: `The last sentence.\r\n${tandf('University of Toronto', '06:31', '24 March 2015')}`,
        expected: 'The last sentence.',
      },
      {
        name: 'a stamp on a real page leaves the page text, word for word',
        input: `${JSTOR_A}\r\n${body}\r\n${oupWatermark('guest', '03 June 2022')}`,
        expected: collapse(body),
      },
    ];
    it.each(rows)('$name', ({ input, expected }) => {
      expect(stripStamps(input)).toBe(expected);
    });
  });

  describe('removes IP addresses, dates and times wherever they appear, and keeps the words around them', () => {
    // `gone`: what must not be left. Without it, no digit may be left at all. (The ISO row names its parts because the order of
    // the steps lets the IPv6 pattern bite the hour out of a timestamp first; the spec does not ask for more than the date.)
    const rows: Array<{ name: string; input: string; keeps: string[]; gone?: string[] }> = [
      { name: 'IPv4 addresses', input: 'Requests came from 192.168.1.20 and 10.0.0.7 during the test.', keeps: ['Requests came from', 'during the test.'] },
      { name: 'an IPv6 address', input: 'The server 2001:db8:85a3::8a2e:370:7334 replied at once.', keeps: ['The server', 'replied at once.'] },
      { name: 'an ISO date with time and zone', input: 'It was logged at 2021-03-14T09:26:53+01:00 by the proxy.', keeps: ['It was logged at', 'by the proxy.'], gone: ['2021', '03-14', '26:53'] },
      { name: 'D Month YYYY', input: 'It was opened on 14 March 2021 for review.', keeps: ['It was opened on', 'for review.'] },
      { name: 'Day, D Mon YYYY HH:MM:SS UTC', input: 'Saved Tue, 03 Mar 2015 14:22:11 UTC and then closed.', keeps: ['Saved', 'and then closed.'] },
      { name: 'Month D, YYYY', input: 'Retrieved March 14, 2021 from the archive.', keeps: ['Retrieved', 'from the archive.'] },
      { name: 'D/M/YYYY', input: 'Printed 14/03/2021 by the office.', keeps: ['Printed', 'by the office.'] },
      { name: 'times with AM/PM and GMT', input: 'Opened at 6:31 PM and closed at 18:45:10 GMT sharp.', keeps: ['Opened at', 'and closed at', 'sharp.'] },
      {
        // GUESS (likely to disagree): the same date on two copies may break across a line at different words, so the
        // patterns must read a line break between the parts of a date as the space it is.
        name: 'a date split over a line break (D Month YYYY)',
        input: 'It was opened on 14 March\r\n2021 for review.',
        keeps: ['It was opened on', 'for review.'],
      },
      {
        name: 'a date split over a line break (Month D, YYYY)',
        input: 'It was accepted on February 26,\r\n2007 by the editor.',
        keeps: ['It was accepted on', 'by the editor.'],
      },
    ];
    it.each(rows)('$name', ({ input, keeps, gone }) => {
      const out = stripStamps(input);
      if (gone) for (const g of gone) expect(out).not.toContain(g);
      else expect(out).not.toMatch(/\d/);
      for (const k of keeps) expect(out).toContain(k);
    });
  });

  describe('leaves body sentences that merely mention "downloaded"', () => {
    const rows: Array<{ name: string; input: string }> = [
      {
        name: 'in the middle of a line, with or without a URL',
        input:
          'The images were downloaded from the project archive and resized to 224 pixels. This content, once downloaded from https://data.example.org/corpus, is cached by the browser.',
      },
      { name: 'a line that starts with "downloaded from the ..."', input: 'All the weights were\r\ndownloaded from the Hugging Face hub and converted to half precision.' },
      {
        name: 'sentences that start with "Downloaded" but are not "Downloaded from <url>" or "Downloaded by [library]"',
        input: 'Downloaded files are checked against a SHA-256 hash before they are opened.\r\nDownloaded by hand, the files were renamed afterwards.',
      },
      {
        // GUESS (likely to disagree): a wrapped body line that happens to begin "downloaded from <url> on ..." is not a stamp line.
        name: 'a wrapped line that begins "downloaded from <url> on ..." in the middle of a paragraph',
        input: 'Both corpora were\r\ndownloaded from https://data.example.org/corpus on request by each lab.',
      },
    ];
    it.each(rows)('$name', ({ input }) => {
      expect(stripStamps(input)).toBe(collapse(input));
    });
  });

  it('numbers that are not IPs, dates or times survive', () => {
    const input = 'Version 1.2.3 reached p = 0.006 with odds of 3:1 in Section 4.2 (2019), pages 1234-1250, doi 10.1371/journal.pone.0000308.';
    expect(stripStamps(input)).toBe(input);
  });

  it('returns single spaces and no edge whitespace, is idempotent, and is empty for an empty or stamp-only page', () => {
    expect(stripStamps('  alpha\r\n\r\n beta\t\tgamma  \n')).toBe('alpha beta gamma');
    expect(stripStamps('')).toBe('');
    expect(stripStamps(JSTOR_A)).toBe('');
    const page = `${LIBRARY_COVER}\r\n${JSTOR_A}\r\n${body}`;
    expect(stripStamps(stripStamps(page))).toBe(stripStamps(page));
  });
});
