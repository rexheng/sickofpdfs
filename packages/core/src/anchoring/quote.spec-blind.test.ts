// Spec-blind table tests for buildTextAnchor (Phase 2, S3).
//
// Sources: contracts section 2 ("Anchors keep both W3C selectors. quote with prefix/suffix is the W3C TextQuoteSelector
// (quote = exact). start/end is a TextPositionSelector scoped to one page"; "end is exclusive"; prefix and suffix are up to
// 32 chars) and the plan's section 7 ("QUOTE_CONTEXT = 32. A quote across pages joins the page texts with '\n'").
// The rects are the caller's: buildTextAnchor stores what it is given.
import { describe, expect, it } from 'vitest';
import type { CharPos } from '../model/anchor';
import { paperPages, selected } from '../../test/spec-blind/anchoring-fixtures';
import { QUOTE_CONTEXT, buildTextAnchor } from './quote';

const pages = paperPages();
const text = (i: number) => pages[i] ?? '';
const at = (page: number, index: number): CharPos => ({ page, index });
const idx = (page: number, needle: string) => pages[page].indexOf(needle);

interface Row {
  name: string;
  texts?: string[];
  start: CharPos;
  end: CharPos;
}

const ROWS: Row[] = [
  { name: 'inside a page, with 32 chars of context on both sides', start: at(1, idx(1, 'specialise')), end: at(1, idx(1, 'specialise') + 'specialise: some track syntax'.length) },
  { name: 'a few chars from the top of the page: the prefix is shorter than 32', start: at(2, 5), end: at(2, 40) },
  { name: 'starting at the very first char: nothing before it', start: at(2, 0), end: at(2, 34) },
  { name: 'ending a few chars from the end of the page: the suffix is shorter than 32', start: at(0, pages[0].length - 40), end: at(0, pages[0].length - 3) },
  { name: 'ending exactly at the end of the page: no suffix (end is exclusive)', start: at(0, pages[0].length - 20), end: at(0, pages[0].length) },
  { name: 'the whole page', start: at(3, 0), end: at(3, pages[3].length) },
  { name: 'across a page break', start: at(0, idx(0, 'Section 3 describes')), end: at(1, idx(1, 'costs about') + 11) },
  { name: 'across three pages: the middle page is taken whole', start: at(0, idx(0, 'Section 3 describes')), end: at(2, idx(2, 'Our tokeniser') + 30) },
  {
    name: 'odd characters are kept exactly (CR LF, double and no-break spaces, ligatures, astral chars)',
    texts: ['Intro line one.\r\nThe ﬁrst  rule says “naïve” 😀 text.\r\nOutro line two, which is long enough to give a suffix.'],
    start: at(0, 17),
    end: at(0, 17 + 'The ﬁrst  rule says “naïve” 😀 text.\r\nOutro'.length),
  },
];

describe('buildTextAnchor', () => {
  it('QUOTE_CONTEXT is 32', () => {
    expect(QUOTE_CONTEXT).toBe(32);
  });

  it.each(ROWS)('$name', ({ texts, start, end }) => {
    const t = texts ?? pages;
    const rects = [{ page: start.page, rects: [[0.1, 0.2, 0.5, 0.25] as [number, number, number, number]] }];
    const a = buildTextAnchor({ text: (i) => t[i] ?? '', start, end, rects });

    expect(a.kind).toBe('text');
    expect(a.start).toEqual(start);
    expect(a.end).toEqual(end);
    // quote = exact: the selected text, untouched (several pages joined with '\n')
    expect(a.quote.quote).toBe(selected(t, start, end));
    // prefix: the chars just before the start, on the start page, at most 32
    const before = t[start.page].slice(0, start.index);
    expect(a.quote.prefix.length).toBeLessThanOrEqual(QUOTE_CONTEXT);
    expect(before.endsWith(a.quote.prefix) || a.quote.prefix.endsWith(before), 'prefix is the text just before the start').toBe(true);
    if (start.index >= QUOTE_CONTEXT) expect(a.quote.prefix).toBe(before.slice(-QUOTE_CONTEXT));
    // suffix: the chars just after the end, on the end page, at most 32
    const after = t[end.page].slice(end.index);
    expect(a.quote.suffix.length).toBeLessThanOrEqual(QUOTE_CONTEXT);
    expect(after.startsWith(a.quote.suffix) || a.quote.suffix.startsWith(after), 'suffix is the text just after the end').toBe(true);
    if (after.length >= QUOTE_CONTEXT) expect(a.quote.suffix).toBe(after.slice(0, QUOTE_CONTEXT));
    // rects are carried through as given
    expect(a.rects).toEqual(rects);
  });

  it('the shorter contexts are exact at the page edges', () => {
    const top = buildTextAnchor({ text: text, start: at(2, 0), end: at(2, 34), rects: [] });
    expect(top.quote.prefix === '' || pages[1].endsWith(top.quote.prefix.replace(/\n$/, '')), 'nothing on this page precedes index 0').toBe(true);
    const end = buildTextAnchor({ text: text, start: at(0, pages[0].length - 20), end: at(0, pages[0].length), rects: [] });
    expect(end.quote.suffix === '' || pages[1].startsWith(end.quote.suffix.replace(/^\n/, '')), 'nothing on this page follows the last char').toBe(true);
  });

  it.each([
    { given: 'ocr:tesseract@5.3', want: 'ocr:tesseract@5.3' },
    { given: undefined, want: undefined },
  ])('textSource $given is carried through; absent stays absent', ({ given, want }) => {
    const a = buildTextAnchor({ text, start: at(1, 10), end: at(1, 50), rects: [], textSource: given });
    // absent means pdfium (the v1 meaning): either no field or the explicit default is fine
    if (want === undefined) expect([undefined, 'pdfium']).toContain(a.textSource);
    else expect(a.textSource).toBe(want);
  });
});
