// Spec-blind table tests for resolveAnchor (Phase 2, S3): where a stored note lands when a PDF is opened again.
//
// Sources: spec "What a note is made of" (re-anchoring on open); contracts section 2 ("Re-anchoring order", "Resolution is
// a view, not data", the PlacedBy / Resolution / AnchorContext shapes); the Phase 2 plan, S3 "Rules" and "Spec-blind table
// tests", and its "Risks" line saying "Moved" shows for fuzzy, caption and image placements; Hypothesis issue #7571
// (a fuzzy fallback that silently re-anchors to a look-alike after the original text was edited).
//
// The order the spec gives: (1) the stored position, if the quote still matches there; (2) the quote on the same page;
// (3) a fuzzy match across the document, nearest pages first, at score >= 0.8 on a quote of >= 12 chars. Anything else is
// "Couldn't place", and an orphan is better than a wrong place.
//
// Text is written the way PDFium returns it: lines end in CR LF, and the "page text" string offsets are the char indices.
// The resolved anchor's rects are not asserted: AnchorContext has no page size, so how rects come back is the code's call.
import { describe, expect, it } from 'vitest';
import type { Anchor, CharPos, NormRect } from '../model/anchor';
import type { PageFigure } from '../model/figures';
import {
  PAPER_PARAGRAPHS,
  STAMP,
  ZERO_HASH,
  anchorOn,
  deepFreeze,
  fakeContext,
  figure,
  find,
  findLoose,
  hashAtDistance,
  pageText,
  paperPages,
  textAnchor,
  withFooter,
  withHeader,
  wrap,
} from '../../test/spec-blind/anchoring-fixtures';
import type { FakeDoc, TextAnchor } from '../../test/spec-blind/anchoring-fixtures';
import { FUZZY_MIN_QUOTE, FUZZY_MIN_SCORE, resolveAnchor } from './reanchor';
import type { PlacedBy } from './reanchor';

const ctxOf = (d: FakeDoc) => fakeContext(d);

const NO_MOVED: PlacedBy[] = ['stored', 'same-page']; // placements the card shows silently
const MOVED: PlacedBy[] = ['fuzzy', 'caption', 'image']; // placements the card labels "Moved" (plan, Risks)
const ORPHAN_REASONS = ['quote-not-found', 'below-threshold'] as const;

it('the two floors are the spec numbers', () => {
  expect(FUZZY_MIN_SCORE).toBe(0.8);
  expect(FUZZY_MIN_QUOTE).toBe(12);
});

// ---------------------------------------------------------------------------------------------------------------
// Text anchors

type Reason = 'quote-not-found' | 'below-threshold' | 'figure-not-found' | 'no-text';
type Want =
  | { placed: true; by: PlacedBy[]; start: CharPos; end: CharPos; tol?: number }
  | { placed: false; reason: readonly Reason[] }
  /** The look-alike rule: the note may be orphaned or placed where it belongs, but never inside [from, to) of `page`. */
  | { placed: 'anywhere-but'; page: number; from: number; to: number };

interface Row {
  name: string;
  before: string[];
  after: string[];
  anchor: (before: string[]) => TextAnchor;
  want: (after: string[]) => Want;
  /** Why the row exists, when the name is not enough. */
  why?: string;
}

const paper = paperPages();
const loose = (page: number, from: string, to?: string, nth = 0) => (t: string[]) => {
  const { start, end } = findLoose(t, page, from, to, nth);
  return textAnchor(t, start, end);
};
const placedAt = (page: number, from: string, to: string | undefined, by: PlacedBy[], o: { nth?: number; tol?: number } = {}) => (t: string[]): Want => ({ placed: true, by, ...findLoose(t, page, from, to, o.nth ?? 0), tol: o.tol });

/** The pages with one paragraph of one page replaced (or removed with `null`). */
function edit(texts: string[], page: number, paragraph: number, replacement: string | null, wrapAt = 60): string[] {
  const ps = PAPER_PARAGRAPHS[page].slice();
  if (replacement === null) ps.splice(paragraph, 1);
  else ps[paragraph] = replacement;
  return texts.map((t, i) => (i === page ? pageText(ps, page + 1, wrapAt) : t));
}

// Issue #7571's witness, word for word: the page is the HTML text content, with no break between the paragraphs.
const ALPHA = 'Team Alpha reported that the new deployment reduced latency by twelve percent across all regions.';
const BETA = 'Team Beta reported that the new deployment reduced latency by twelve percent across all regions.';
const ISSUE_QUOTE = 'reduced latency by twelve percent across all regions';
const issueBefore = [`${ALPHA}${BETA}`];
const issueAnchor = (t: string[]): TextAnchor => {
  const a = anchorOn(t, 0, ISSUE_QUOTE, 0);
  // The selector the issue prints: prefix and suffix are the 32 chars on each side of the first sentence's phrase.
  expect(a.quote.prefix).toBe('eported that the new deployment ');
  expect(a.quote.suffix).toBe('.Team Beta reported that the new');
  return a;
};
const betaStart = (t: string[]) => t[0].lastIndexOf(ISSUE_QUOTE);

// The repeated-phrase rows
const PHRASE = 'the results are summarised in the table below';
const repeatedPage = pageText(
  [
    `For the small models, ${PHRASE}. Larger models follow in Section 4 and in the appendix tables.`,
    'The optimiser settings, the seeds and the exact data splits are listed in the supplementary material so that each run can be repeated by another group.',
    `For the medium models, ${PHRASE}. Their training curves are shown in Figure 3 with the same axes.`,
    'Wall-clock times were taken on shared machines and should be read as rough guides rather than as benchmarks of any one system.',
    `For the large models, ${PHRASE}. We stopped early because of the cost of each additional run.`,
  ],
  1,
  200, // one line per paragraph: the page is only a vehicle for the repeats
);
const occurrence = (page: string, nth: number) => [...page.matchAll(new RegExp(PHRASE, 'g'))][nth].index;
const gap12 = occurrence(repeatedPage, 1) - occurrence(repeatedPage, 0);
/** A header 80% as long as the gap between the first two occurrences: once it is added, the first one sits nearer to the old index of the second. */
const longStamp = 'Downloaded from the publisher site by an authorised user of the library. '.repeat(12).slice(0, Math.round(gap12 * 0.8) - 2);

const BLOCK =
  'Source: company filings, 2022, and the annual reports of each firm. Note: all values are in millions of dollars unless stated otherwise in the column heading.';
const blockPage = pageText(
  [
    BLOCK,
    'Revenue grew in every region except the north, where two large contracts ended during the year and were not replaced for several months.',
    BLOCK,
    'Operating costs followed revenue closely, with the main difference being a one-off charge for the move to the new head office building.',
    BLOCK,
  ],
  1,
  200,
);

const SCAN = ['', '', '', ''];

// From the last paragraph of page 0 into the first of page 1: "Section 3 ... costs about two points".
const crossPageAt = (t: string[]): { start: CharPos; end: CharPos } => ({
  start: { page: 0, index: t[0].indexOf('Section 3 describes the data pipeline') },
  end: { page: 1, index: t[1].indexOf('costs about two points') + 'costs about two points'.length },
});
const crossPage = (t: string[]): TextAnchor => textAnchor(t, crossPageAt(t).start, crossPageAt(t).end);

const ROWS: Row[] = [
  // ---- the same bytes, and stamps -----------------------------------------------------------------------------
  {
    name: 'the same PDF: the stored position still holds the quote',
    before: paper,
    after: paper,
    anchor: loose(1, 'The attention heads specialise: some', 'across a long sentence.'),
    want: (t) => ({ placed: true, by: ['stored'], ...findLoose(t, 1, 'The attention heads specialise: some', 'across a long sentence.') }),
  },
  {
    name: 'the stored position wins when the phrase is repeated on the page (not the first occurrence)',
    before: [repeatedPage],
    after: [repeatedPage],
    anchor: (t) => anchorOn(t, 0, PHRASE, 1),
    want: (t) => ({ placed: true, by: ['stored'], ...find(t, 0, PHRASE, 1) }),
  },
  {
    name: 'a header stamp on every page moves every index: the quote is found on the same page',
    before: paper,
    after: withHeader(paper),
    anchor: loose(2, 'Human raters preferred the new translations', 'pairwise comparisons'),
    want: (t) => ({ placed: true, by: ['same-page'], ...findLoose(t, 2, 'Human raters preferred the new translations', 'pairwise comparisons') }),
    why: 'a stamped re-download is the same words in new places: no "Moved" label',
  },
  {
    name: 'a header stamp, passage at the very top of the page (empty prefix)',
    before: paper,
    after: withHeader(paper),
    anchor: loose(2, 'Related work on sparse transformers', 'from quadratic to near linear'),
    want: (t) => ({ placed: true, by: ['same-page'], ...findLoose(t, 2, 'Related work on sparse transformers', 'from quadratic to near linear') }),
  },
  {
    name: 'a footer stamp: nothing before it moves',
    before: paper,
    after: withFooter(paper),
    anchor: loose(0, 'Training loss fell smoothly', 'until the final decay.'),
    want: (t) => ({ placed: true, by: NO_MOVED, ...findLoose(t, 0, 'Training loss fell smoothly', 'until the final decay.') }),
  },
  {
    name: 'a stamp on one page only: other pages keep their positions',
    before: paper,
    after: withHeader(paper, STAMP, [1]),
    anchor: loose(2, 'Latency was measured on a single CPU core', 'the cache warm.'),
    want: (t) => ({ placed: true, by: ['stored'], ...findLoose(t, 2, 'Latency was measured on a single CPU core', 'the cache warm.') }),
  },
  {
    name: 'quote with regex characters, ligatures and curly quotes survives a header stamp',
    before: [pageText(['Use the pattern (a+b)*c? [x] {y} | $1 ^start \\d when p < 0.05 & q > 0.9; the ﬁne-grained “naïve” café variant is rarer.'], 1, 200)],
    after: withHeader([pageText(['Use the pattern (a+b)*c? [x] {y} | $1 ^start \\d when p < 0.05 & q > 0.9; the ﬁne-grained “naïve” café variant is rarer.'], 1, 200)]),
    anchor: (t) => anchorOn(t, 0, '(a+b)*c? [x] {y} | $1 ^start \\d when p < 0.05 & q > 0.9'),
    want: (t) => ({ placed: true, by: ['same-page'], ...find(t, 0, '(a+b)*c? [x] {y} | $1 ^start \\d when p < 0.05 & q > 0.9') }),
  },
  {
    name: 'the stored index lies past the end of the new page text',
    before: paper,
    // page 0 loses its first four paragraphs, so the page is now far shorter than the old index
    after: paper.map((t, i) => (i === 0 ? pageText(PAPER_PARAGRAPHS[0].slice(4), 1) : t)),
    anchor: loose(0, 'and the augmentation scheme in detail'),
    want: (t) => ({ placed: true, by: ['same-page'], ...findLoose(t, 0, 'and the augmentation scheme in detail') }),
  },

  // ---- repeated phrases ---------------------------------------------------------------------------------------
  {
    name: 'repeated phrase, distinct contexts: the right occurrence even when a wrong one is nearer to the old index',
    before: [repeatedPage],
    after: [`${longStamp}\r\n${repeatedPage}`],
    anchor: (t) => anchorOn(t, 0, PHRASE, 1),
    want: (t) => ({ placed: true, by: ['same-page'], ...find(t, 0, PHRASE, 1) }),
    why: 'the stamp is 80% of the gap between occurrences: by position alone the first one is nearer to the old index',
  },
  {
    name: 'repeated block, identical contexts: the occurrence nearest the old index',
    before: [blockPage],
    after: withHeader([blockPage]),
    anchor: (t) => anchorOn(t, 0, 'all values are in millions of dollars', 1),
    want: (t) => ({ placed: true, by: ['same-page'], ...find(t, 0, 'all values are in millions of dollars', 1) }),
  },

  // ---- reflow, edits and moves: fuzzy, with "Moved" ---------------------------------------------------------------
  {
    name: 'reflowed text (line breaks fall elsewhere): fuzzy',
    before: paper,
    after: paper.map((t, i) => (i === 1 ? pageText(PAPER_PARAGRAPHS[1], 2, 85) : t)),
    anchor: loose(1, 'The attention heads specialise: some', 'across a long sentence.'),
    want: placedAt(1, 'The attention heads specialise: some', 'across a long sentence.', ['fuzzy'], { tol: 4 }),
    why: 'the card must show "Moved"',
  },
  {
    name: 'reflow pushes the passage onto the next page',
    before: paper,
    // the last two paragraphs of page 1 move, intact, to the top of page 2
    after: paper.map((t, i) => (i === 1 ? pageText(PAPER_PARAGRAPHS[1].slice(0, 3), 2) : i === 2 ? pageText([...PAPER_PARAGRAPHS[1].slice(3), ...PAPER_PARAGRAPHS[2]], 3) : t)),
    anchor: loose(1, 'The largest variant has 340 million parameters', 'at inference time.'),
    want: placedAt(2, 'The largest variant has 340 million parameters', 'at inference time.', ['fuzzy'], { tol: 4 }),
  },
  {
    name: 'a moderate edit inside the passage (a few words changed), context intact',
    before: paper,
    after: edit(paper, 0, 3, 'Training loss fell steadily for the first fifty epochs and then plateaued near 0.31 until the final decay.'),
    anchor: loose(0, 'Training loss fell smoothly for the first forty epochs', 'until the final decay.'),
    want: placedAt(0, 'Training loss fell steadily for the first fifty epochs', 'until the final decay.', ['fuzzy'], { tol: 6 }),
  },
  {
    name: 'two exact copies on other pages: the nearer page wins',
    before: paper,
    // The paragraph leaves page 2. It now stands, with its neighbours, on page 0 (2 pages away) and on page 3 (1 page away).
    after: paper.map((t, i) => {
      const block = PAPER_PARAGRAPHS[2].slice(1, 4);
      return i === 0 ? pageText([...block, ...PAPER_PARAGRAPHS[0]], 1) : i === 2 ? pageText(PAPER_PARAGRAPHS[2].filter((_, k) => k !== 2), 3) : i === 3 ? pageText([...block, ...PAPER_PARAGRAPHS[3]], 4) : t;
    }),
    anchor: loose(2, 'Human raters preferred the new translations', 'pairwise comparisons we collected.'),
    want: placedAt(3, 'Human raters preferred the new translations', 'pairwise comparisons we collected.', ['fuzzy'], { tol: 2 }),
  },
  {
    name: 'a quote across a page break: a header on the first page moves its start, its end stays',
    before: paper,
    after: withHeader(paper, STAMP, [0]),
    anchor: crossPage,
    want: (t) => ({ placed: true, by: ['same-page', 'fuzzy'], ...crossPageAt(t) }), // the contracts do not say which step a quote across pages belongs to
  },
  {
    name: 'a quote across a page break, nothing changed: stored',
    before: paper,
    after: paper,
    anchor: crossPage,
    want: (t) => ({ placed: true, by: ['stored'], ...crossPageAt(t) }),
  },

  // ---- floors -------------------------------------------------------------------------------------------------
  {
    name: '12-char quote with one typo and intact context: fuzzy (at the floor)',
    before: paper,
    after: paper.map((t, i) => (i === 1 ? t.replace('key-value cache', 'key-valve cache') : t)),
    anchor: (t) => anchorOn(t, 1, 'key-value ca'),
    want: (t) => ({ placed: true, by: ['fuzzy', 'same-page'], ...find(t, 1, 'key-valve ca'), tol: 1 }),
    why: 'FUZZY_MIN_QUOTE is 12: the quote is long enough',
  },
  {
    name: '11-char quote with one typo and intact context: Couldn\'t place (below the floor)',
    before: paper,
    after: paper.map((t, i) => (i === 1 ? t.replace('key-value cache', 'key-valve cache') : t)),
    anchor: (t) => anchorOn(t, 1, 'key-value c'),
    want: () => ({ placed: false, reason: ORPHAN_REASONS }),
    why: 'FUZZY_MIN_QUOTE is 12: fuzzy matching is not allowed on a quote this short',
  },
  {
    name: 'a short quote that is exact on another page only: Couldn\'t place',
    before: paper,
    after: paper.map((t, i) => (i === 1 ? pageText(PAPER_PARAGRAPHS[1].slice(0, 4), 2) : i === 2 ? pageText([PAPER_PARAGRAPHS[1][4], ...PAPER_PARAGRAPHS[2]], 3) : t)),
    anchor: (t) => anchorOn(t, 1, '340 million'),
    want: () => ({ placed: false, reason: ORPHAN_REASONS }),
    why: 'under 12 chars the document-wide search is off, so a short phrase is never carried to another page',
  },
  {
    name: 'a short quote that is exact on the same page: placed',
    before: paper,
    after: withHeader(paper),
    anchor: (t) => anchorOn(t, 1, '340 million'),
    want: (t) => ({ placed: true, by: ['same-page'], ...find(t, 1, '340 million') }),
  },
  {
    name: 'the passage was rewritten (quote similarity far under 0.8) with the same neighbours',
    before: paper,
    after: edit(paper, 0, 3, 'Training loss dropped quickly during the opening epochs, then oscillated around a higher value for the remainder of the run.'),
    anchor: loose(0, 'Training loss fell smoothly for the first forty epochs', 'until the final decay.'),
    want: () => ({ placed: false, reason: ORPHAN_REASONS }),
  },
  {
    name: 'the passage was deleted',
    before: paper,
    after: edit(paper, 2, 2, null),
    anchor: loose(2, 'Human raters preferred the new translations', 'pairwise comparisons we collected.'),
    want: () => ({ placed: false, reason: ORPHAN_REASONS }),
  },
  {
    name: 'a scan: no page has any text',
    before: paper,
    after: SCAN,
    anchor: loose(1, 'The attention heads specialise: some', 'across a long sentence.'),
    want: () => ({ placed: false, reason: ['no-text'] }),
  },

  // ---- look-alikes (Hypothesis #7571) -----------------------------------------------------------------------------
  {
    name: '#7571 verbatim: Alpha\'s sentence is edited, Beta\'s identical phrase must not capture the note',
    before: issueBefore,
    after: [`Team Alpha reported that the new deployment reduced latency by twenty percent across all regions after further optimization.${BETA}`],
    anchor: issueAnchor,
    want: (t) => ({ placed: 'anywhere-but', page: 0, from: betaStart(t), to: betaStart(t) + ISSUE_QUOTE.length }),
    why: 'the phrase is exact in Beta\'s paragraph, which is a different note\'s text: an orphan, or Alpha\'s edited sentence (with "Moved"), never Beta',
  },
  {
    name: 'look-alike, exact quote but different words around it on both sides (the original paragraph is gone)',
    before: paper.map((t, i) => (i === 0 ? pageText([...PAPER_PARAGRAPHS[0], ALPHA], 1, 400) : t)),
    after: paper.map((t, i) =>
      i === 0
        ? pageText(PAPER_PARAGRAPHS[0], 1)
        : i === 2
          ? pageText(['In the staging cluster the nightly job reduced latency by twelve percent across all regions, which the ops group could repeat.', ...PAPER_PARAGRAPHS[2]], 3, 400)
          : t,
    ),
    anchor: (t) => anchorOn(t, 0, ISSUE_QUOTE),
    want: () => ({ placed: false, reason: ORPHAN_REASONS }),
    why: 'an orphan is better than a wrong place',
  },
  {
    name: 'look-alike on the same page: the sentence is gone and another says nearly the same thing',
    before: paper,
    after: edit(paper, 1, 3, 'Warming the learning rate over a few thousand steps helped the early phase of training, as it did in the earlier tests.'),
    anchor: loose(1, 'We found that warming the learning rate for four thousand steps', 'early phase of training.'),
    want: () => ({ placed: false, reason: ORPHAN_REASONS }),
  },
];

describe('resolveAnchor: text anchors', () => {
  it('the repeated-phrase fixtures are what their rows say they are', () => {
    // distinct contexts: the stamp is long enough that, by position alone, the first occurrence would be taken for the second
    const first = occurrence(repeatedPage, 0);
    const second = occurrence(repeatedPage, 1);
    const shift = longStamp.length + 2;
    expect(Math.abs(first + shift - second)).toBeLessThan(Math.abs(second + shift - second));
    // identical contexts: the occurrences are further apart than twice the shift of the plain stamp, so "nearest" is unambiguous
    const block = 'all values are in millions of dollars';
    const at = (n: number) => [...blockPage.matchAll(new RegExp(block, 'g'))][n].index;
    expect(at(1) - at(0)).toBeGreaterThan(2 * (STAMP.length + 2));
    expect(at(2) - at(1)).toBeGreaterThan(2 * (STAMP.length + 2));
  });

  it.each(ROWS)('$name', async (row) => {
    const stored = deepFreeze(row.anchor(row.before)); // frozen: writing to it throws
    const snapshot = JSON.stringify(stored);
    const ctx = ctxOf({ texts: row.after });

    const res = await resolveAnchor(stored, ctx);
    const want = row.want(row.after);

    expect(JSON.stringify(stored), 'the stored anchor is never rewritten').toBe(snapshot);

    if (want.placed === true) {
      expect(res.placed, `placed (${JSON.stringify(res)})`).toBe(true);
      if (!res.placed) return;
      expect(want.by, `by = ${res.by}`).toContain(res.by);
      expect(res.score).toBeGreaterThanOrEqual(FUZZY_MIN_SCORE);
      expect(res.score).toBeLessThanOrEqual(1);
      if (res.by === 'stored') expect(res.score).toBe(1);
      expect(res.anchor.kind).toBe('text');
      if (res.anchor.kind !== 'text') return;
      const tol = want.tol ?? 0;
      expect(res.anchor.start.page, 'start page').toBe(want.start.page);
      expect(res.anchor.end.page, 'end page').toBe(want.end.page);
      expect(Math.abs(res.anchor.start.index - want.start.index), `start ${res.anchor.start.index} vs ${want.start.index}`).toBeLessThanOrEqual(tol);
      expect(Math.abs(res.anchor.end.index - want.end.index), `end ${res.anchor.end.index} vs ${want.end.index}`).toBeLessThanOrEqual(tol);
    } else if (want.placed === false) {
      expect(res.placed, `must not be placed (${JSON.stringify(res)})`).toBe(false);
      if (res.placed) return;
      expect(want.reason, `reason = ${res.reason}`).toContain(res.reason);
    } else if (res.placed && res.anchor.kind === 'text') {
      const inDecoy = res.anchor.start.page === want.page && res.anchor.start.index >= want.from - 2 && res.anchor.start.index < want.to;
      expect(inDecoy, `placed inside the look-alike at ${res.anchor.start.index} (by ${res.by}, score ${res.score})`).toBe(false);
      expect(MOVED, 'a placement that is not exact must carry the Moved label').toContain(res.by);
    }
  });
});

describe('resolveAnchor: the result is a view, not data', () => {
  it('resolving does not remember: the same anchor is stored again on the original bytes after a stamped copy', async () => {
    const stored = deepFreeze(loose(2, 'Human raters preferred the new translations', 'pairwise comparisons')(paper));
    const stamped = await resolveAnchor(stored, ctxOf({ texts: withHeader(paper) }));
    const original = await resolveAnchor(stored, ctxOf({ texts: paper }));
    expect(stamped.placed && stamped.by).toBe('same-page');
    expect(original.placed && original.by).toBe('stored');
    if (stamped.placed && original.placed && stamped.anchor.kind === 'text' && original.anchor.kind === 'text') {
      expect(stamped.anchor.start.index).toBe(original.anchor.start.index + STAMP.length + 2);
      expect(original.anchor.start).toEqual(stored.start);
    }
  });

  it('the resolved anchor is for the open bytes: resolving it again there is stored', async () => {
    const stored = loose(2, 'Human raters preferred the new translations', 'pairwise comparisons')(paper);
    const ctx = ctxOf({ texts: withHeader(paper) });
    const first = await resolveAnchor(stored, ctx);
    expect(first.placed).toBe(true);
    if (!first.placed) return;
    const again = await resolveAnchor(first.anchor, ctx);
    expect(again.placed && again.by).toBe('stored');
  });

  it.each<[string, Anchor]>([
    ['a page note', { kind: 'page', page: 2 }],
    ['a point note', { kind: 'point', page: 1, point: [0.25, 0.5] }],
    ['a document note', { kind: 'document' }],
  ])('%s has nothing to re-anchor: it is placed, unchanged', async (_name, stored) => {
    const res = await resolveAnchor(deepFreeze(stored), ctxOf({ texts: withHeader(paper) }));
    expect(res.placed).toBe(true);
    if (res.placed) expect(res.anchor).toEqual(stored);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Figure anchors (research 06 section 5; spec: "a figure comment stays put while its fingerprint matches; otherwise it
// follows its caption, then its image. Anything else goes to Couldn't place")

const HASH = 'a1'.repeat(32);
const OTHER_HASH = 'b2'.repeat(32);
const CAPTION = 'Figure 3: Validation accuracy by depth for the three model sizes.';
const figPages = (captionPage: number | null, extra: Record<number, string> = {}): string[] =>
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => {
    const body = `${wrap(`Body text of page ${i + 1}, which discusses results that are unrelated to any chart on this page and carries no caption.`)}`;
    return `${body}\r\n${i === captionPage ? CAPTION : (extra[i] ?? `Table ${i + 1}: Summary figures for run ${i + 1}.`)}\r\n${i + 1}`;
  });
const STORED_PAGE = 4;

function figureAnchor(texts: string[], o: { image?: string | null; caption?: boolean; label?: string | null; dHash?: string } = {}): Extract<Anchor, { kind: 'figure' }> {
  const at = find(texts, STORED_PAGE, CAPTION);
  const cap = textAnchor(texts, at.start, at.end);
  return {
    kind: 'figure',
    page: STORED_PAGE,
    rect: [0.1, 0.2, 0.6, 0.5] satisfies NormRect,
    figure: {
      label: o.label === undefined ? 'Figure 3' : o.label,
      captionQuote: o.caption === false ? null : { ...cap.quote, position: at.start },
      imageSha256: o.image === undefined ? HASH : o.image,
      dHash: o.dHash ?? ZERO_HASH,
      detector: 'objects',
      detectorVersion: '1',
    },
    sub: { point: [0.4, 0.5] },
  };
}

interface FigRow {
  name: string;
  /** The document the note was made in has the caption on STORED_PAGE. */
  after: () => FakeDoc;
  anchor?: Parameters<typeof figureAnchor>[1];
  want: { placed: true; by: PlacedBy; page: number } | { placed: false };
}

const withCaption = (page: number) => figPages(page);
const figs = (m: Record<number, PageFigure[]>) => m;

const FIG_ROWS: FigRow[] = [
  {
    name: 'same image hash on the stored page: stays put (the caption text and the picture hash both changed)',
    after: () => ({ texts: figPages(null), figures: figs({ [STORED_PAGE]: [figure({ imageSha256: HASH, label: null })] }), dHash: () => hashAtDistance(30) }),
    want: { placed: true, by: 'figure-match', page: STORED_PAGE },
  },
  {
    name: 'same caption quote at its stored position: stays put (image bytes and picture hash both changed)',
    after: () => {
      const texts = withCaption(STORED_PAGE);
      const at = find(texts, STORED_PAGE, CAPTION).start.index;
      return { texts, figures: figs({ [STORED_PAGE]: [figure({ imageSha256: OTHER_HASH, caption: { start: at, end: at + CAPTION.length, text: CAPTION } })] }), dHash: () => hashAtDistance(30) };
    },
    want: { placed: true, by: 'figure-match', page: STORED_PAGE },
  },
  {
    name: 'picture hash 10 bits away (DHASH_MATCH_MAX): stays put',
    anchor: { image: null, caption: false },
    after: () => ({ texts: figPages(null), dHash: () => hashAtDistance(10) }),
    want: { placed: true, by: 'figure-match', page: STORED_PAGE },
  },
  {
    name: 'picture hash 11 bits away and nothing else to go on: Couldn\'t place',
    anchor: { image: null, caption: false },
    after: () => ({ texts: figPages(null), dHash: () => hashAtDistance(11) }),
    want: { placed: false },
  },
  {
    name: 'the figure moved two pages: it follows its caption (and the card says Moved)',
    after: () => {
      const texts = withCaption(STORED_PAGE + 2);
      const at = find(texts, STORED_PAGE + 2, CAPTION).start.index;
      return {
        texts,
        figures: figs({ [STORED_PAGE + 2]: [figure({ imageSha256: OTHER_HASH, label: 'Figure 3', caption: { start: at, end: at + CAPTION.length, text: CAPTION } })] }),
        dHash: () => hashAtDistance(40),
      };
    },
    want: { placed: true, by: 'caption', page: STORED_PAGE + 2 },
  },
  {
    name: 'caption and image both found, on different pages: the caption wins',
    after: () => ({
      texts: withCaption(7),
      figures: figs({ 7: [figure({ imageSha256: OTHER_HASH, label: 'Figure 3' })], 8: [figure({ imageSha256: HASH, label: null })] }),
      dHash: () => hashAtDistance(40),
    }),
    want: { placed: true, by: 'caption', page: 7 },
  },
  {
    name: 'the caption is gone: it follows its image',
    after: () => ({ texts: figPages(null), figures: figs({ 7: [figure({ imageSha256: HASH, label: null })] }), dHash: () => hashAtDistance(40) }),
    want: { placed: true, by: 'image', page: 7 },
  },
  {
    name: 'the same image on two pages: the page nearer to the stored one (4)',
    after: () => ({
      texts: figPages(null),
      figures: figs({ 1: [figure({ imageSha256: HASH, label: null })], 6: [figure({ imageSha256: HASH, label: null })] }),
      dHash: () => hashAtDistance(40),
    }),
    want: { placed: true, by: 'image', page: 6 }, // page 1 is 3 pages away, page 6 is 2
  },
  {
    name: 'nothing matches anywhere: Couldn\'t place',
    after: () => ({ texts: figPages(null), figures: figs({ 7: [figure({ imageSha256: OTHER_HASH })] }), dHash: () => hashAtDistance(40) }),
    want: { placed: false },
  },
  {
    name: 'a caption is found but no figure is detected there and there is no image: Couldn\'t place',
    after: () => ({ texts: withCaption(7), figures: {}, dHash: () => hashAtDistance(40) }),
    want: { placed: false },
  },
  {
    name: 'look-alike caption: "Figure 4" with the same words must not capture a note on "Figure 3"',
    after: () => ({
      texts: figPages(null, { 7: CAPTION.replace('Figure 3', 'Figure 4') }),
      figures: figs({ 7: [figure({ imageSha256: OTHER_HASH, label: 'Figure 4' })] }),
      dHash: () => hashAtDistance(40),
    }),
    want: { placed: false },
  },
];

describe('resolveAnchor: figure anchors', () => {
  it.each(FIG_ROWS)('$name', async (row) => {
    const before = figPages(STORED_PAGE);
    const stored = deepFreeze(figureAnchor(before, row.anchor));
    const snapshot = JSON.stringify(stored);
    const res = await resolveAnchor(stored, ctxOf(row.after()));

    expect(JSON.stringify(stored), 'the stored anchor is never rewritten').toBe(snapshot);
    if (!row.want.placed) {
      expect(res.placed, JSON.stringify(res)).toBe(false);
      if (!res.placed) expect(res.reason).toBe('figure-not-found');
      return;
    }
    expect(res.placed, JSON.stringify(res)).toBe(true);
    if (!res.placed) return;
    expect(res.by).toBe(row.want.by);
    expect(res.anchor.kind).toBe('figure');
    if (res.anchor.kind !== 'figure') return;
    expect(res.anchor.page).toBe(row.want.page);
    expect(res.anchor.sub, 'pins and sub-areas are stored relative to the figure, so they travel with it').toEqual(stored.sub);
    if (res.by === 'figure-match') expect(res.anchor.rect).toEqual(stored.rect); // it stayed put
    const [x0, y0, x1, y1] = res.anchor.rect;
    expect([x0, y0, x1, y1].every((n) => n >= 0 && n <= 1) && x0 < x1 && y0 < y1, `a valid 0-1 rectangle: ${JSON.stringify(res.anchor.rect)}`).toBe(true);
  });
});
