import { readFileSync } from 'node:fs';

/** One page for the P0-4 text-layer suite. `file` is relative to fixtures/out/ (the test server's root). */
export interface TextlayerFixture {
  name: string;
  file: string;
  /** Page index (0-based). */
  page: number;
  dir: 'ltr' | 'rtl';
  /** The page's text as a reader would copy it (fixtures/src/<name>.txt), for the generated fixtures only. */
  truth?: string;
  /** A sentence near the bottom of column 2 (TWO_COLUMN only). */
  column2LastSentence?: string;
}

const truth = (name: string) => readFileSync(new URL(`../fixtures/src/${name}.txt`, import.meta.url), 'utf8');

// tl-*.pdf: `pnpm -C spikes/phase0 fixtures:textlayer`; the arXiv papers: `pnpm -C spikes/phase0 fixtures`.
export const TWO_COLUMN: TextlayerFixture = {
  name: 'two-column',
  file: 'tl-two-column.pdf',
  page: 0,
  dir: 'ltr',
  truth: truth('two-column'),
  column2LastSentence: 'Repairs are planned for next autumn, once the river has dropped below the level of the old stones.',
};
export const RTL: TextlayerFixture = { name: 'rtl', file: 'tl-rtl.pdf', page: 0, dir: 'rtl', truth: truth('rtl') };

export const TEXTLAYER_FIXTURES: TextlayerFixture[] = [
  TWO_COLUMN,
  { name: 'rotated-table', file: 'tl-rotated-table.pdf', page: 0, dir: 'ltr', truth: truth('rotated-table') },
  { name: 'ligatures', file: 'tl-ligatures.pdf', page: 0, dir: 'ltr', truth: truth('ligatures') },
  { name: 'maths', file: 'tl-maths.pdf', page: 0, dir: 'ltr', truth: truth('maths') },
  RTL,
  // tl-two-column.pdf with /Rotate 90, so its text is the two-column text.
  { name: 'rotated-page', file: 'tl-rotated-page.pdf', page: 0, dir: 'ltr', truth: truth('two-column') },
  // Real pages: ResNet page 1 (two columns, hyphenated line ends); Attention page 1 (ligatures, superscript
  // symbols). Attention page 1 has no inline maths, so page 2 (h_t, h_{t−1}) is added for it.
  { name: 'resnet-p1', file: 'classifier/learning/arxiv-1512.03385-resnet.pdf', page: 0, dir: 'ltr' },
  { name: 'attention-p1', file: 'classifier/learning/arxiv-1706.03762-attention.pdf', page: 0, dir: 'ltr' },
  { name: 'attention-p2', file: 'classifier/learning/arxiv-1706.03762-attention.pdf', page: 1, dir: 'ltr' },
];
