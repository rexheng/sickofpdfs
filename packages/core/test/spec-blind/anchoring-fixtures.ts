// Shared test data for the spec-blind anchoring tests (S3). Nothing here comes from the code under test: the selectors
// are built by hand from the contract's words (W3C TextQuoteSelector with 32-char prefix and suffix, a TextPositionSelector
// scoped to one page, a quote across pages joined with '\n'), and the page texts are written the way PDFium returns them
// (lines end in CR LF).
import type { PageGlyphs, PdfRect, SearchHit } from '../../../viewer/src/backend/types';
import type { Anchor, CharPos, NormRect } from '../../src/model/anchor';
import type { PageFigure } from '../../src/model/figures';

export type TextAnchor = Extract<Anchor, { kind: 'text' }>;
export type FigureAnchor = Extract<Anchor, { kind: 'figure' }>;

export const CONTEXT = 32;

// ---------------------------------------------------------------------------------------------------------------
// Prose

/** Greedy word wrap at `at` chars, joined with CR LF: a paragraph as PDFium returns it. */
export function wrap(text: string, at = 60): string {
  const lines: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + w.length > at) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines.join('\r\n');
}

/** A page of PDFium text: wrapped paragraphs, each on its own lines, then the page number. */
export function pageText(paragraphs: string[], pageNo: number, wrapAt = 60): string {
  return `${paragraphs.map((p) => wrap(p, wrapAt)).join('\r\n')}\r\n${pageNo}`;
}

/** Four pages of distinct prose, as a paper's text. Every sentence is unique, so no 12-char quote repeats by accident. */
export const PAPER_PARAGRAPHS: string[][] = [
  [
    'Residual connections let each layer learn a correction to its input instead of a whole new representation.',
    'We trained the model on eight GPUs for three and a half days using the Adam optimiser with a cosine schedule.',
    'The baseline reaches 71.2 percent accuracy on the held-out validation split, which is the figure to beat.',
    'Training loss fell smoothly for the first forty epochs and then plateaued near 0.31 until the final decay.',
    'Section 3 describes the data pipeline and the augmentation scheme in detail, including the crop sizes.',
  ],
  [
    'Ablation studies show that removing the second normalisation layer costs about two points of accuracy.',
    'The attention heads specialise: some track syntax, while others follow rare words across a long sentence.',
    'Memory use grows linearly with sequence length once the key-value cache is enabled for decoding.',
    'We found that warming the learning rate for four thousand steps stabilised the early phase of training.',
    'The largest variant has 340 million parameters and needs 11 GB of memory at inference time.',
  ],
  [
    'Related work on sparse transformers reduces the cost of attention from quadratic to near linear in length.',
    'Our tokeniser splits rare words into pieces, which keeps the vocabulary at thirty two thousand entries.',
    'Human raters preferred the new translations in 63 percent of the pairwise comparisons we collected.',
    'Latency was measured on a single CPU core with the batch size set to one and the cache warm.',
    'The appendix lists every hyper-parameter, including the ones we did not tune at all.',
  ],
  [
    'Limitations. The method has only been tested on English text and on documents shorter than ten thousand words.',
    'Future work will look at longer contexts and at languages with a very different word order.',
    'Acknowledgements. We thank the reviewers for their careful reading and for pointing out two errors in the draft.',
  ],
];

export const paperPages = (): string[] => PAPER_PARAGRAPHS.map((ps, i) => pageText(ps, i + 1));

// ---------------------------------------------------------------------------------------------------------------
// Selectors, built from the contract

/** Where `needle` is on a page: a position pair (end exclusive). */
export function find(texts: readonly string[], page: number, needle: string, nth = 0): { start: CharPos; end: CharPos } {
  let from = -1;
  for (let k = 0; k <= nth; k++) {
    from = texts[page].indexOf(needle, from + 1);
    if (from < 0) throw new Error(`fixture error: ${JSON.stringify(needle)} (occurrence ${nth}) is not on page ${page}`);
  }
  return { start: { page, index: from }, end: { page, index: from + needle.length } };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Like `find`, but a space in the needles matches any run of white space, so a phrase is found whether the line breaks
 * fall inside it or not. The range runs from the start of `from` to the end of the first `to` after it.
 */
export function findLoose(texts: readonly string[], page: number, from: string, to: string = from, nth = 0): { start: CharPos; end: CharPos } {
  const re = (s: string) => new RegExp(s.split(' ').map(escapeRe).join('\\s+'), 'g');
  const starts = [...texts[page].matchAll(re(from))];
  const first = starts[nth];
  if (!first) throw new Error(`fixture error: ${JSON.stringify(from)} (occurrence ${nth}) is not on page ${page}`);
  const rest = re(to);
  rest.lastIndex = first.index;
  const last = rest.exec(texts[page]);
  if (!last) throw new Error(`fixture error: ${JSON.stringify(to)} does not follow ${JSON.stringify(from)} on page ${page}`);
  return { start: { page, index: first.index }, end: { page, index: last.index + last[0].length } };
}

/** The text a position pair selects. Several pages are joined with '\n'. */
export function selected(texts: readonly string[], start: CharPos, end: CharPos): string {
  if (start.page === end.page) return texts[start.page].slice(start.index, end.index);
  const parts = [texts[start.page].slice(start.index)];
  for (let p = start.page + 1; p < end.page; p++) parts.push(texts[p]);
  parts.push(texts[end.page].slice(0, end.index));
  return parts.join('\n');
}

/** The W3C selectors for a range, as the contract describes them. `rects` is whatever the caller gives (the engine's job). */
export function textAnchor(texts: readonly string[], start: CharPos, end: CharPos, o: { rects?: TextAnchor['rects']; textSource?: string } = {}): TextAnchor {
  const a: TextAnchor = {
    kind: 'text',
    quote: {
      quote: selected(texts, start, end),
      prefix: texts[start.page].slice(Math.max(0, start.index - CONTEXT), start.index),
      suffix: texts[end.page].slice(end.index, end.index + CONTEXT),
    },
    start,
    end,
    rects: o.rects ?? [],
  };
  if (o.textSource !== undefined) a.textSource = o.textSource;
  return a;
}

/** Anchor on a phrase of a page. */
export function anchorOn(texts: readonly string[], page: number, needle: string, nth = 0): TextAnchor {
  const { start, end } = find(texts, page, needle, nth);
  return textAnchor(texts, start, end);
}

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

// ---------------------------------------------------------------------------------------------------------------
// A document as the anchoring code sees it: the AnchorContext of contracts section 2, made from page strings

export interface PageTextProviderLike {
  source(pageIndex: number): string;
  text(pageIndex: number): Promise<string>;
  glyphs(pageIndex: number): Promise<PageGlyphs>;
  rects(pageIndex: number, start: number, count: number): Promise<PdfRect[]>;
  search(pageIndex: number, query: string, o: { matchCase: boolean; wholeWord: boolean }): Promise<SearchHit[]>;
}

export interface AnchorContextLike {
  pageCount: number;
  text: PageTextProviderLike;
  figures(pageIndex: number): Promise<PageFigure[]>;
  dHash(pageIndex: number, rect: NormRect): Promise<string>;
}

export interface FakeDoc {
  texts: readonly string[];
  /** Figures per page, as the detector would give them for these bytes. */
  figures?: Record<number, PageFigure[]>;
  /** The perceptual hash of a region, for these bytes. */
  dHash?: (pageIndex: number, rect: NormRect) => string;
  source?: string;
}

export const ZERO_HASH = '0000000000000000';

export function fakeContext(doc: FakeDoc): AnchorContextLike {
  const source = doc.source ?? 'pdfium';
  const at = (i: number): string => doc.texts[i] ?? '';
  const rectsFor = (pageIndex: number, start: number, count: number): PdfRect[] => {
    // One 6 x 10 pt box per char on a CR LF grid: enough to give any caller plausible, non-empty rectangles.
    const t = at(pageIndex);
    const rects: PdfRect[] = [];
    let line = 0;
    let col = 0;
    let open: PdfRect | null = null;
    for (let i = 0; i < Math.min(t.length, start + count); i++) {
      const ch = t[i];
      if (ch === '\r') continue;
      if (ch === '\n') {
        line++;
        col = 0;
        open = null;
        continue;
      }
      if (i >= start) {
        if (!open) rects.push((open = { x: col * 6, y: line * 12, width: 0, height: 10 }));
        open.width += 6;
      }
      col++;
    }
    return rects;
  };
  return {
    pageCount: doc.texts.length,
    text: {
      source: () => source,
      text: (i) => Promise.resolve(at(i)),
      glyphs: (i) =>
        Promise.resolve({
          pageIndex: i,
          glyphs: [...at(i)].map((ch, index) => ({
            index,
            text: ch,
            box: { x: index * 6, y: 0, width: 6, height: 10 },
            tight: { x: index * 6, y: 0, width: 6, height: 10 },
            fontSize: 10,
            angle: 0,
            generated: ch === '\r' || ch === '\n',
          })),
          runs: [{ start: 0, end: at(i).length }],
        }),
      rects: (i, start, count) => Promise.resolve(rectsFor(i, start, count)),
      search: (i, query, o) => {
        const hay = o.matchCase ? at(i) : at(i).toLowerCase();
        const needle = o.matchCase ? query : query.toLowerCase();
        const hits: SearchHit[] = [];
        for (let k = needle ? hay.indexOf(needle) : -1; k >= 0; k = hay.indexOf(needle, k + 1)) hits.push({ pageIndex: i, start: k, count: query.length, rects: rectsFor(i, k, query.length) });
        return Promise.resolve(hits);
      },
    },
    figures: (i) => Promise.resolve(doc.figures?.[i] ?? []),
    dHash: (i, rect) => Promise.resolve(doc.dHash ? doc.dHash(i, rect) : ZERO_HASH),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Download stamps, on page strings

export const STAMP = 'This content downloaded from 128.40.12.7 on Tue, 14 Mar 2023 10:22:41 UTC';

/** A header: PDFium reads it first, so every index on the page moves by stamp.length + 2. */
export const withHeader = (texts: readonly string[], stamp = STAMP, pages?: number[]): string[] => texts.map((t, i) => (!pages || pages.includes(i) ? `${stamp}\r\n${t}` : t));
/** A footer: indices before it do not move. */
export const withFooter = (texts: readonly string[], stamp = STAMP): string[] => texts.map((t) => `${t}\r\n${stamp}`);

// ---------------------------------------------------------------------------------------------------------------
// Figures

export function figure(o: Partial<PageFigure> & { index?: number } = {}): PageFigure {
  return {
    kind: 'image',
    rect: { x: 100, y: 120, width: 300, height: 200 },
    label: 'Figure 3',
    captionRect: null,
    confidence: 'high',
    index: 0,
    objectIndices: [],
    caption: null,
    imageSha256: null,
    ...o,
  };
}

/** A 64-bit hash with exactly `bits` bits set, as 16 hex chars: its Hamming distance from ZERO_HASH is `bits`. */
export function hashAtDistance(bits: number): string {
  let hex = '';
  for (let nibble = 0; nibble < 16; nibble++) {
    const n = Math.max(0, Math.min(4, bits - nibble * 4));
    hex += ((((1 << n) - 1) << (4 - n)) & 0xf).toString(16);
  }
  return hex;
}
