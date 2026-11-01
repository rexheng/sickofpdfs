// Task 22's text-layer pages: the generated tl-*.pdf fixtures (scripts/fixtures/make-textlayer.mjs, under /f/ on the
// fixture server once `pnpm fixtures` has run) and two real papers. `truth` is the page's text as a reader would copy it
// (scripts/fixtures/textlayer-src/<name>.txt, written by hand), for the generated fixtures only.
import { readFileSync } from 'node:fs';

export interface TextlayerFixture {
  name: string;
  /** The path under the fixture server's /f/ (test-assets/). */
  file: string;
  /** Page index (0-based). */
  page: number;
  dir: 'ltr' | 'rtl';
  truth?: string;
}

const truth = (name: string) => readFileSync(new URL(`../../scripts/fixtures/textlayer-src/${name}.txt`, import.meta.url), 'utf8');

export const TEXTLAYER_FIXTURES: TextlayerFixture[] = [
  { name: 'two-column', file: 'tl-two-column.pdf', page: 0, dir: 'ltr', truth: truth('two-column') },
  { name: 'rotated-table', file: 'tl-rotated-table.pdf', page: 0, dir: 'ltr', truth: truth('rotated-table') },
  { name: 'ligatures', file: 'tl-ligatures.pdf', page: 0, dir: 'ltr', truth: truth('ligatures') },
  { name: 'maths', file: 'tl-maths.pdf', page: 0, dir: 'ltr', truth: truth('maths') },
  { name: 'rtl', file: 'tl-rtl.pdf', page: 0, dir: 'rtl', truth: truth('rtl') },
  // tl-two-column.pdf with /Rotate 90, so its text is the two-column text.
  { name: 'rotated-page', file: 'tl-rotated-page.pdf', page: 0, dir: 'ltr', truth: truth('two-column') },
  // ResNet page 1: two columns, hyphenated line ends, a footnote mark. Attention page 1: ligatures, superscript symbols.
  { name: 'resnet-p1', file: 'classifier/learning/arxiv-1512.03385-resnet.pdf', page: 0, dir: 'ltr' },
  { name: 'attention-p1', file: 'classifier/learning/arxiv-1706.03762-attention.pdf', page: 0, dir: 'ltr' },
];
