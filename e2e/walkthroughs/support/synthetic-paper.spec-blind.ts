// A paper-shaped PDF made on the spot, in three versions, for the re-anchoring walkthrough. Everything about it is known from this
// file, so the expected result of opening it never comes from the product:
//   - v1: the paper. One sentence stands alone on a line in the middle (TARGET).
//   - v2: the same paper with one word of that sentence changed: the passage is still there, nearly. A note on v1 must be placed on it
//         and the card must say "Moved".
//   - v3: the same paper with that sentence replaced by an unrelated one of about the same length: the passage is gone. A note on v1
//         must go to "Couldn't place", and nothing may be drawn.
// All three differ from each other by well under 0.5% of their text, so the library takes them for the same document (a stamped
// re-download: "Re-downloads that differ only by a download stamp ... are recognised by their text").
// The paper has an arXiv id on its first page and a References heading at its end, which the spec says always saves: "Force save: an
// arXiv id plus a References section".
import { typesetPdf } from '../../../packages/viewer/test/spec-blind/p2-pdf-fixtures';

export type Variant = 'v1' | 'v2' | 'v3';

export const TARGET = {
  v1: 'The placebo test found no anticipation effects before adoption.',
  v2: 'The placebo test found no anticipated effects before adoption.',
  v3: 'Standard errors were clustered at the level of the treated unit.',
} as const;
/** Words on the line, for finding it with the engine's search. */
export const TARGET_PASSAGE = {
  v1: { from: 'The placebo test found no anticipation', to: 'before adoption.' },
  v2: { from: 'The placebo test found no anticipated', to: 'before adoption.' },
} as const;

const SUBJECTS = ['the estimator', 'the staggered design', 'the control group', 'the treated cohort', 'the event window', 'the pooled sample', 'the weighting scheme', 'the bandwidth choice'];
const VERBS = ['stays stable under', 'is sensitive to', 'improves on', 'is dominated by', 'converges faster than', 'is biased by', 'is robust to', 'diverges from'];
const OBJECTS = ['the baseline specification', 'heterogeneous effects', 'a longer pre-period', 'clustered errors', 'the covariate set', 'a trimmed sample', 'late adopters', 'the outcome scale'];

/** A tiny seeded generator (mulberry32), so the paper is the same every time. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function paragraphs(variant: Variant): string[] {
  const rand = rng(20261101);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const out: string[] = [
    'arXiv:2411.01234v1 [econ.EM]',
    'A synthetic study of staggered adoption',
    'Abstract',
    'We study how the estimator behaves when adoption is staggered across units, and we report estimates for each cohort.',
  ];
  for (let i = 0; i < 118; i++) {
    const sentences = Array.from({ length: 3 }, (_, k) => {
      const value = (rand() * 9 + 0.1).toFixed(2);
      return `In specification ${i + 1}.${k + 1}, ${pick(SUBJECTS)} ${pick(VERBS)} ${pick(OBJECTS)}, with an estimate of ${value} and a standard error of ${(rand() / 4 + 0.01).toFixed(3)}.`;
    });
    out.push(sentences.join(' '));
    if (i === 58) out.push(TARGET[variant]); // the middle of the paper, alone on its line
  }
  out.push('References');
  for (let r = 1; r <= 8; r++) out.push(`[${r}] A. Author and B. Writer. Estimating effects with staggered adoption, part ${r}. Journal of Applied Methods, volume ${r}, pages ${r * 10} to ${r * 10 + 9}. doi:10.1000/sop.${r}00${r}`);
  return out;
}

/** The PDF bytes of one version of the paper. */
export async function makePaper(variant: Variant): Promise<Uint8Array> {
  return (await typesetPdf(paragraphs(variant), { wrapAt: 72, fontSize: 11, leading: 14 })).bytes;
}
