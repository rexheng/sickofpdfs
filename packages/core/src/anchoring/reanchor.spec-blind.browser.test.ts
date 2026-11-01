// Spec-blind browser tests for re-anchoring on real PDF text (Phase 2, S3): the merged engine reads real pages of the
// papers in test-assets/, and resolveAnchor places stored notes in them.
//
// What is real here: the page text (PDFium's, with its CR LF line ends), the way a stamp or a reflow moves chars, and the
// papers themselves. What is built: the stamps (pdf-lib adds one line to every page, before the page's own text or after
// it), the reflowed and edited pages (the same sentences typeset line by line at two widths), and the selectors (by hand,
// from the contract). The fixture generators are in packages/viewer/test/spec-blind/p2-pdf-fixtures.ts.
//
// Needs `pnpm fixtures` (test-assets/classifier) and the engine assets (the browser project's global setup copies them).
// Every resolved placement is checked for one more thing: the stored anchor, frozen, is never rewritten.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifier, copyOf } from '../../../viewer/test/spec-blind/browser-helpers';
import { DOWNLOAD_STAMP, stampPdf, typesetPdf } from '../../../viewer/test/spec-blind/p2-pdf-fixtures';
import { engineAssets } from '../../../viewer/src/backend/embedpdf/assets';
import { createEmbedPdfBackend } from '../../../viewer/src/backend/embedpdf/backend';
import type { DocHandle, PdfBackend } from '../../../viewer/src/backend/types';
import { PAPER_PARAGRAPHS, deepFreeze, findLoose, selected, textAnchor } from '../../test/spec-blind/anchoring-fixtures';
import type { AnchorContextLike, TextAnchor } from '../../test/spec-blind/anchoring-fixtures';
import type { Anchor, CharPos, NormRect } from '../model/anchor';
import { FUZZY_MIN_SCORE, resolveAnchor } from './reanchor';
import type { PlacedBy } from './reanchor';

const ASSETS = engineAssets((path) => new URL(`/apps/extension/public/${path}`, globalThis.location.href).href);
const SLOW = 90_000;

let backend: PdfBackend;
beforeAll(() => {
  backend = createEmbedPdfBackend(ASSETS);
});
afterAll(() => {
  (backend as { dispose?: () => void }).dispose?.();
});

interface Opened {
  doc: DocHandle;
  texts: string[];
  ctx: AnchorContextLike;
  sizes: { width: number; height: number }[];
}

/** Opens a PDF and reads every page's text: the AnchorContext the viewer would build (no figures here). */
async function open(bytes: Uint8Array): Promise<Opened> {
  const info = await backend.open(copyOf(bytes));
  const texts = await Promise.all(info.pages.map((_, i) => backend.getPageText(info.doc, i)));
  const ctx: AnchorContextLike = {
    pageCount: info.pageCount,
    text: {
      source: () => 'pdfium',
      text: (i) => Promise.resolve(texts[i] ?? ''),
      glyphs: (i) => backend.getPageGlyphs(info.doc, i),
      rects: (i, start, count) => backend.getTextRangeRects(info.doc, i, start, count),
      search: (i, q, o) => backend.searchPage(info.doc, i, q, o),
    },
    figures: () => Promise.resolve([]),
    dHash: () => Promise.resolve('0'.repeat(16)),
  };
  return { doc: info.doc, texts, ctx, sizes: info.pages };
}

/** An anchor with real rects (the engine's line rectangles, as 0-1 of the page), the way the viewer stores one. */
async function anchorWithRects(o: Opened, start: CharPos, end: CharPos): Promise<TextAnchor> {
  const rects: TextAnchor['rects'] = [];
  for (let page = start.page; page <= end.page; page++) {
    const from = page === start.page ? start.index : 0;
    const to = page === end.page ? end.index : o.texts[page].length;
    const { width, height } = o.sizes[page];
    const pdf = await backend.getTextRangeRects(o.doc, page, from, to - from);
    rects.push({ page, rects: pdf.map((r): NormRect => [r.x / width, r.y / height, (r.x + r.width) / width, (r.y + r.height) / height]) });
  }
  return textAnchor(o.texts, start, end, { rects });
}

/** Resolves a frozen anchor and checks it was not written to. */
async function resolve(stored: Anchor, o: Opened) {
  const frozen = deepFreeze(structuredClone(stored));
  const snapshot = JSON.stringify(frozen);
  const res = await resolveAnchor(frozen, o.ctx);
  expect(JSON.stringify(frozen), 'the stored anchor is never rewritten').toBe(snapshot);
  return res;
}

function expectPlacedAt(res: Awaited<ReturnType<typeof resolve>>, by: PlacedBy[], want: { start: CharPos; end: CharPos }, tol = 0) {
  expect(res.placed, JSON.stringify(res)).toBe(true);
  if (!res.placed || res.anchor.kind !== 'text') return;
  expect(by, `placed by ${res.by}`).toContain(res.by);
  expect(res.score).toBeGreaterThanOrEqual(FUZZY_MIN_SCORE);
  expect(res.anchor.start.page).toBe(want.start.page);
  expect(res.anchor.end.page).toBe(want.end.page);
  expect(Math.abs(res.anchor.start.index - want.start.index), `start ${res.anchor.start.index} vs ${want.start.index}`).toBeLessThanOrEqual(tol);
  expect(Math.abs(res.anchor.end.index - want.end.index), `end ${res.anchor.end.index} vs ${want.end.index}`).toBeLessThanOrEqual(tol);
}

const QUIET: PlacedBy[] = ['stored', 'same-page'];

// Real passages, each on one page of a paper in test-assets/classifier/learning: [file, page index, first words, last words].
// A passage may run over a line break; findLoose reads a space as "any white space".
const PASSAGES: [file: string, page: number, from: string, to: string][] = [
  ['arxiv-1706.03762-attention.pdf', 2, 'Encoder: The encoder is composed of a stack of N = 6 identical layers', 'feed-forward network.'],
  ['arxiv-1512.03385-resnet.pdf', 1, 'Shortcut connections [2, 34, 49] are those skipping one or more layers.', 'one or more layers.'],
  ['arxiv-1802.03042-deep-hedging.pdf', 1, 'Essentially, we model the trading decisions in our hedging strategies as neural networks', 'neural networks'],
  ['plosone-10.1371-journal.pone.0000308.pdf', 1, 'To confirm that these findings were not dependent on a few', 'extremely high-profile papers'],
];
const PAPER = (file: string) => classifier(`learning/${file}`);

describe('the same PDF', () => {
  it.each(PASSAGES)('%s p.%i: an exact anchor re-places where it was, as "stored"', async (file, page, from, to) => {
    const bytes = await PAPER(file);
    const first = await open(bytes);
    const { start, end } = findLoose(first.texts, page, from, to);
    const stored = await anchorWithRects(first, start, end);
    expect(stored.quote.quote.length, 'a real passage').toBeGreaterThan(30);

    const second = await open(bytes); // a fresh handle: nothing shared with the first
    const res = await resolve(stored, second);
    expectPlacedAt(res, ['stored'], { start, end });
    if (res.placed) expect(res.score).toBe(1);
  }, SLOW);
});

describe('a re-download with a download stamp', () => {
  const S2 = 'This content downloaded from 2001:db8:85a3::8a2e:370:7334 on Wed, 07 Jun 2023 18:03:09 +00:00. All use subject to https://about.jstor.org/terms';

  it.each(PASSAGES)('%s p.%i: a header stamp moves every char on the page: re-placed by quote, with no "Moved"', async (file, page, from, to) => {
    const bytes = await PAPER(file);
    const original = await open(bytes);
    const { start, end } = findLoose(original.texts, page, from, to);
    const stored = await anchorWithRects(original, start, end);

    const stamped = await open(await stampPdf(bytes, { where: 'header' }));
    const shift = stamped.texts[page].length - original.texts[page].length;
    expect(stamped.texts[page], 'precondition: the stamp is read first, then the page as it was').toBe(`${DOWNLOAD_STAMP}\r\n${original.texts[page]}`);
    expect(shift).toBeGreaterThan(0);

    const res = await resolve(stored, stamped);
    expectPlacedAt(res, ['same-page'], { start: { page, index: start.index + shift }, end: { page, index: end.index + shift } });
    // the words are the same words
    if (res.placed && res.anchor.kind === 'text') expect(selected(stamped.texts, res.anchor.start, res.anchor.end)).toBe(stored.quote.quote);
  }, SLOW);

  it.each(PASSAGES)('%s p.%i: a footer stamp leaves the chars before it where they were', async (file, page, from, to) => {
    const bytes = await PAPER(file);
    const original = await open(bytes);
    const { start, end } = findLoose(original.texts, page, from, to);
    const stored = await anchorWithRects(original, start, end);

    const stamped = await open(await stampPdf(bytes, { where: 'footer' }));
    expect(stamped.texts[page].startsWith(original.texts[page]), 'precondition: the footer is read last').toBe(true);
    expectPlacedAt(await resolve(stored, stamped), QUIET, { start, end });
  }, SLOW);

  it('a note made on one stamped copy comes back on another copy with a different stamp (another address, date and length)', async () => {
    const [file, page, from, to] = PASSAGES[0];
    const bytes = await PAPER(file);
    const first = await open(await stampPdf(bytes, { where: 'header', line: DOWNLOAD_STAMP }));
    const { start, end } = findLoose(first.texts, page, from, to);
    const stored = await anchorWithRects(first, start, end);

    const second = await open(await stampPdf(bytes, { where: 'header', line: S2 }));
    const shift = S2.length - DOWNLOAD_STAMP.length;
    expect(shift).not.toBe(0);
    expectPlacedAt(await resolve(stored, second), ['same-page'], { start: { page, index: start.index + shift }, end: { page, index: end.index + shift } });
  }, SLOW);

  it('a quote across a page break: a header on the first page moves its start and not its end', async () => {
    const bytes = await PAPER('arxiv-1706.03762-attention.pdf');
    const original = await open(bytes);
    // from "The output is computed as a weighted sum" at the foot of page 3 into the first words of page 4
    const start: CharPos = { page: 2, index: original.texts[2].indexOf('The output is computed as a weighted sum') };
    const end: CharPos = { page: 3, index: 'Scaled Dot-Product Attention'.length };
    expect(start.index, 'precondition').toBeGreaterThan(0);
    expect(original.texts[3].startsWith('Scaled Dot-Product Attention'), 'precondition').toBe(true);
    const stored = textAnchor(original.texts, start, end);
    expect(stored.quote.quote).toContain('\n'); // joined with '\n'

    const same = await resolve(stored, await open(bytes));
    expectPlacedAt(same, ['stored'], { start, end });

    const stamped = await open(await stampPdf(bytes, { where: 'header', pages: [2] }));
    const shift = stamped.texts[2].length - original.texts[2].length;
    // the contracts do not say whether a quote across pages is placed by the same-page step or the document-wide one
    expectPlacedAt(await resolve(stored, stamped), ['same-page', 'fuzzy'], { start: { page: 2, index: start.index + shift }, end });
  }, SLOW);
});

describe('a phrase that is repeated on a page goes to the right occurrence', () => {
  // [file, page, phrase]: each phrase occurs several times on that page, in different places (headings, labels, prose).
  const REPEATS: [string, number, string][] = [
    ['arxiv-1706.03762-attention.pdf', 3, 'Scaled Dot-Product Attention'],
    ['arxiv-1512.03385-resnet.pdf', 1, 'shortcut connections'],
    ['arxiv-1802.03042-deep-hedging.pdf', 1, 'hedging strategies'],
  ];

  const similarity = (a: string, b: string) => {
    let same = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) same++;
    return same / Math.max(a.length, b.length, 1);
  };

  it.each(REPEATS)('%s p.%i: "%s", every occurrence with a context of its own', async (file, page, phrase) => {
    const bytes = await PAPER(file);
    const original = await open(bytes);
    const stamped = await open(await stampPdf(bytes, { where: 'header' }));
    const shift = stamped.texts[page].length - original.texts[page].length;

    const text = original.texts[page];
    const starts: number[] = [];
    for (let k = text.indexOf(phrase); k >= 0; k = text.indexOf(phrase, k + 1)) starts.push(k);
    expect(starts.length, `"${phrase}" occurs more than once on the page`).toBeGreaterThan(1);

    const anchors = starts.map((k) => textAnchor(original.texts, { page, index: k }, { page, index: k + phrase.length }));
    // an occurrence whose 32 chars on each side look like another one's cannot be told apart by the words around it
    const distinct = anchors.filter((a, i) => anchors.every((b, j) => i === j || similarity(a.quote.prefix + a.quote.suffix, b.quote.prefix + b.quote.suffix) < 0.5));
    expect(distinct.length, 'at least two occurrences with contexts of their own').toBeGreaterThanOrEqual(2);

    for (const a of distinct) {
      const res = await resolve(a, stamped);
      expectPlacedAt(res, ['same-page'], { start: { page, index: a.start.index + shift }, end: { page, index: a.end.index + shift } });
    }
  }, SLOW);
});

describe('reflowed and edited text, set line by line at two widths', () => {
  const sets = PAPER_PARAGRAPHS[1];
  const typeset = (paragraphs: string[], o: { wrapAt: number; fontSize?: number }) => typesetPdf(paragraphs, { ...o, leading: (o.fontSize ?? 11) + 3 }).then((t) => t.bytes);

  it('the same sentences wrapped at another width: found by the fuzzy step, and the card says "Moved"', async () => {
    const narrow = await open(await typeset(sets, { wrapAt: 48 }));
    const wide = await open(await typeset(sets, { wrapAt: 84 }));
    const from = 'The attention heads specialise: some';
    const to = 'across a long sentence.';
    const { start, end } = findLoose(narrow.texts, 0, from, to);
    const stored = await anchorWithRects(narrow, start, end);
    expect(stored.quote.quote, 'precondition: the passage runs over a line break').toMatch(/\r\n/);

    const res = await resolve(stored, wide);
    expectPlacedAt(res, ['fuzzy'], findLoose(wide.texts, 0, from, to), 4);
    if (res.placed) expect(res.score).toBeLessThan(1);
  }, SLOW);

  it('and back again, at the same width: stored', async () => {
    const wide = await open(await typeset(sets, { wrapAt: 84 }));
    const { start, end } = findLoose(wide.texts, 0, 'The attention heads specialise: some', 'across a long sentence.');
    const stored = await anchorWithRects(wide, start, end);
    expectPlacedAt(await resolve(stored, await open(await typeset(sets, { wrapAt: 84 }))), ['stored'], { start, end });
  }, SLOW);

  // Hypothesis issue #7571: after Alpha's sentence is edited, the same words in Beta's sentence must not capture the note.
  const ALPHA = 'Team Alpha reported that the new deployment reduced latency by twelve percent across all regions.';
  const ALPHA_EDITED = 'Team Alpha reported that the new deployment reduced latency by twenty percent across all regions after further optimization.';
  const BETA = 'Team Beta reported that the new deployment reduced latency by twelve percent across all regions.';
  const QUOTE = 'reduced latency by twelve percent across all regions';
  const set = (paragraphs: string[]) => typeset(paragraphs, { wrapAt: 140, fontSize: 7 }); // one line per paragraph

  it('#7571: Alpha is edited in place, Beta says the same words: the note is not put on Beta', async () => {
    const before = await open(await set([ALPHA, BETA]));
    const { start, end } = findLoose(before.texts, 0, QUOTE, QUOTE);
    const stored = await anchorWithRects(before, start, end);
    expect(before.texts[0].indexOf(QUOTE)).toBe(start.index); // it is Alpha's

    const after = await open(await set([ALPHA_EDITED, BETA]));
    const betaAt = after.texts[0].indexOf(QUOTE, after.texts[0].indexOf('Team Beta'));
    expect(betaAt, 'precondition: the exact phrase is in Beta').toBeGreaterThan(0);

    const res = await resolve(stored, after);
    if (res.placed && res.anchor.kind === 'text') {
      expect(res.anchor.start.index, `placed at ${res.anchor.start.index} by ${res.by}: Beta's phrase is at ${betaAt}`).toBeLessThan(betaAt - 20);
      expect(['fuzzy'], 'an edited sentence is a Moved placement').toContain(res.by);
    } else expect(res.placed).toBe(false); // an orphan is better than a wrong place
  }, SLOW);

  it('#7571: Alpha is deleted, a sentence elsewhere with the same words but other surroundings: Couldn\'t place', async () => {
    const before = await open(await set([ALPHA, BETA]));
    const { start, end } = findLoose(before.texts, 0, QUOTE, QUOTE);
    const stored = await anchorWithRects(before, start, end);

    const LOOKALIKE = 'In the staging cluster the nightly job reduced latency by twelve percent across all regions, which the ops group could repeat.';
    const after = await open(await set([LOOKALIKE, 'The remaining teams reported no change in tail latency over the same period of the trial.']));
    expect(after.texts[0]).toContain(QUOTE); // precondition: the words are there, exactly

    const res = await resolve(stored, after);
    expect(res.placed, JSON.stringify(res)).toBe(false);
  }, SLOW);

  it('the sentence is deleted: Couldn\'t place, and nothing is drawn', async () => {
    const before = await open(await typeset(sets, { wrapAt: 60 }));
    const { start, end } = findLoose(before.texts, 0, 'Memory use grows linearly with sequence length', 'enabled for decoding.');
    const stored = await anchorWithRects(before, start, end);
    const after = await open(await typeset(sets.filter((_, i) => i !== 2), { wrapAt: 60 }));
    const res = await resolve(stored, after);
    expect(res.placed).toBe(false);
    if (!res.placed) expect(['quote-not-found', 'below-threshold']).toContain(res.reason);
  }, SLOW);
});
