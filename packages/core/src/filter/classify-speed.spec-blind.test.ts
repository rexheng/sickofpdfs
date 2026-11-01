// Spec-blind tests: classify is fast (Phase 3, plan S2 and spec step 1).
//
// Sources:
//   spec, "Learning filter and privacy", step 1: "Score from cheap signals in under 150 ms".
//   contract section 5: "classify(input, rules): steps 1-2 of the spec, synchronous, < 150 ms".
//   plan S2: "Pure and synchronous, under 150 ms on the largest sample."
//
// The largest sample is the real fixture whose first-and-last-5-pages text is longest (the extracted PDFium inputs, see
// classify-fixtures.spec-blind.test.ts). Each test file runs in its own module scope, so the first call below is the first
// call in this process: the same cold start a viewer tab pays when it classifies its one PDF.
//
// The adversarial rows are the same size as the largest real sample (about 60,000 characters in 10 pages) but built to make
// a careless regular expression back-track: long digit runs, repeated separators and near-misses of every hard-block shape.
// A filter that stalls on a hostile PDF is a way to hang the viewer.
import { describe, expect, it } from 'vitest';
import { MANIFEST, SOURCE_MODES, fixtureInput, fixtureRecord, mkInput, rulesOf } from '../../test/spec-blind/filter-kit';
import type { FilterInput } from '../../test/spec-blind/filter-kit';
import { classify } from './classify';

// Triage (TB1): the spec's 150 ms is for the reference laptop. Like the e2e speed bounds (e2e/support/perf-budget.ts), it
// holds with SOP_PERF_STRICT=1 and is three times looser otherwise, so a loaded, shared box does not fail on load alone.
const LIMIT_MS = process.env.SOP_PERF_STRICT === '1' ? 150 : 3 * 150;
const timeOnce = (input: FilterInput): number => {
  const t0 = performance.now();
  classify(input, rulesOf());
  return performance.now() - t0;
};
const bestOf = (n: number, input: FilterInput): number => Math.min(...Array.from({ length: n }, () => timeOnce(input)));
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const chars = (texts: readonly string[]) => texts.reduce((n, t) => n + t.length, 0);

describe('speed on the largest real sample', () => {
  // Found before any timing, from the manifest and the extracted files.
  const largest = [...MANIFEST].sort((a, b) => chars(fixtureRecord(b).sampleText) - chars(fixtureRecord(a).sampleText))[0];

  it('the first (cold) call on the largest sample takes under 150 ms', () => {
    const input = fixtureInput(largest, 'content-only');
    expect(chars(input.sampleText), `${largest.path} should be a big sample`).toBeGreaterThan(20_000);
    const ms = timeOnce(input);
    if (process.env.SOP_FILTER_TABLE) console.info(`cold: ${largest.path} ${chars(input.sampleText)} chars ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it('later calls on it stay under 150 ms (median of 15)', () => {
    const input = fixtureInput(largest, 'with-source');
    const runs = Array.from({ length: 15 }, () => timeOnce(input));
    expect(median(runs)).toBeLessThan(LIMIT_MS);
  });

  it.each(SOURCE_MODES)('every one of the 44 fixtures classifies in under 150 ms (%s)', (mode) => {
    // best of 3 per file: a scheduler or GC pause while other test files run must not fail a sweep of 44
    const slow = MANIFEST.map((item) => ({ item, ms: bestOf(3, fixtureInput(item, mode)) })).filter((r) => r.ms >= LIMIT_MS);
    expect(slow.map((r) => `${r.item.path}: ${r.ms.toFixed(0)} ms`)).toEqual([]);
  });
});

describe('speed on hostile text of the same size (no catastrophic back-tracking)', () => {
  const PAGE_CHARS = 6000;
  const fill = (unit: string) => unit.repeat(Math.ceil(PAGE_CHARS / unit.length)).slice(0, PAGE_CHARS);
  const rows: Array<[string, string]> = [
    ['one long run of digits', '1234567890'],
    ['digits separated by single spaces', '9 '],
    ['card-shaped groups that all fail the checksum', '4111 1111 1111 1112 '],
    ['card-shaped groups that all pass it, run together', '4111111111111111'],
    ['IBAN-shaped fragments', 'GB82 WEST 1234 5698 '],
    ['sort-code-shaped groups with no account', 'Sort code 40-47-84 '],
    ['sort-code and account labels with no numbers', 'Sort code Account number '],
    ['NI-shaped groups with the wrong suffix', 'AB 12 34 56 Z '],
    ['SSN-shaped groups with an impossible area', '000-12-3456 '],
    ['UTR labels with the wrong digit count', 'UTR 12345 6789 '],
    ['passport-line filler', '<<<<<<<<<<'],
    ['a boarding-pass prefix over and over', 'M1 M1 M1 M1 '],
    ['"arXiv:" with no number', 'arXiv: arXiv:2301. '],
    ['headings with nothing behind them', 'References\r\nAbstract\r\nChapter\r\nContents\r\n'],
    ['a single character, no spaces at all', 'a'],
    ['only line breaks and spaces', ' \r\n \r\n'],
    ['currency symbols and separators', '£1,234.56 $7.89 € '],
    ['URL-shaped words and DOIs without endings', 'https://doi.org/10. 10.1000/ '],
  ];

  it.each(rows)('%s', (_name, unit) => {
    const page = fill(unit);
    const input = mkInput({ pageCount: 40, sampleText: Array.from({ length: 10 }, () => page), url: 'https://example.com/a.pdf' });
    expect(chars(input.sampleText)).toBe(60_000);
    expect(bestOf(3, input)).toBeLessThan(LIMIT_MS);
  });

  it('one page of 200,000 characters with no spaces (3.3 times the largest sample: linear time allows 500 ms)', () => {
    const input = mkInput({ pageCount: 1, sampleText: ['x'.repeat(200_000)] });
    expect(bestOf(3, input)).toBeLessThan(LIMIT_MS * (200_000 / 60_000));
  });

  it('a very long link and file name', () => {
    const input = mkInput({ pageCount: 4, url: `https://example.com/${'a/'.repeat(25_000)}x.pdf?${'k=v&'.repeat(10_000)}`, fileName: `${'n'.repeat(50_000)}.pdf` });
    expect(bestOf(3, input)).toBeLessThan(LIMIT_MS);
  });
});
