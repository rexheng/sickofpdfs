// Layout boxes (pixels of the drawn page) to the figures the viewer outlines (PageFigure's detector shape, contracts §2).
// Pure functions: no DOM, no model. The rule, written once:
// - Only figure-like boxes count: image, chart, table. Text, titles, formulas, headers and footers never become a figure.
// - Boxes of one thing overlap (the model often says "image" and "chart" for the same plot): the best score stands for the group.
// - A box inside a bigger one is a panel of it; the bigger one stands.
// - Score 0.5 and up is `high` (outlined on hover). 0.3 to 0.5 is `medium` (shown while Alt is held). Lower is dropped.
// - A caption is the nearest figure/table/chart title above or below with some width in common; its words come from OCR.
import type { DetectedFigure, OcrWord } from '@sop/core';
import type { PageSize, PdfRect } from '@sop/viewer';
import { displayedPxToPage } from '../engine/engine';
import { LAYOUT_DETECTOR, type LayoutBox, type LayoutLabel } from './models';

export const HIGH_SCORE = 0.5;
export const MEDIUM_SCORE = 0.3;
/** A figure at least this share of the page's width and height (a scan's specks and rules are not figures). */
const MIN_SIDE_SHARE = 0.06;
const FIGURE_LABELS: readonly LayoutLabel[] = ['image', 'chart', 'table'];
const TITLE_LABELS: readonly LayoutLabel[] = ['figure_title', 'chart_title', 'table_title'];

export interface ScanFigure extends DetectedFigure {
  detector: typeof LAYOUT_DETECTOR;
  caption: { start: number; end: number; text: string } | null;
}

const area = (b: LayoutBox) => b.width * b.height;
function overlap(a: LayoutBox, b: LayoutBox): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
const iou = (a: LayoutBox, b: LayoutBox) => overlap(a, b) / (area(a) + area(b) - overlap(a, b));

/** The figure boxes of a page, best first, with overlapping and nested ones folded away. */
export function figureBoxes(boxes: readonly LayoutBox[], img: { width: number; height: number }): LayoutBox[] {
  const cands = boxes
    .filter((b) => FIGURE_LABELS.includes(b.label) && b.score >= MEDIUM_SCORE && b.width >= img.width * MIN_SIDE_SHARE && b.height >= img.height * MIN_SIDE_SHARE)
    .sort((a, b) => b.score - a.score);
  const kept: LayoutBox[] = [];
  for (const c of cands) {
    if (kept.some((k) => iou(k, c) > 0.5 || overlap(k, c) / area(c) > 0.85)) continue;
    kept.push(c);
  }
  return kept;
}

const LABEL = /^(fig(?:ure)?s?\.?|table|chart|tab\.?)\s*([0-9]+(?:[.-][0-9]+)*[a-z]?|[ivxlc]+)\b/i;

/** "Figure 3" from a caption's first words, or null. */
export function captionLabel(text: string): string | null {
  const m = LABEL.exec(text.trim());
  if (!m) return null;
  const word = /^t/i.test(m[1]) ? 'Table' : /^c/i.test(m[1]) ? 'Chart' : 'Figure';
  return `${word} ${m[2]}`;
}

/** The nearest caption title of `fig`: below it, or above it, within 12% of the page height, sharing at least 40% of the narrower width. */
function titleFor(fig: LayoutBox, titles: readonly LayoutBox[], img: { height: number }): LayoutBox | null {
  let best: LayoutBox | null = null;
  let bestGap = Infinity;
  for (const t of titles) {
    const gap = t.y >= fig.y + fig.height - 4 ? t.y - (fig.y + fig.height) : fig.y >= t.y + t.height - 4 ? fig.y - (t.y + t.height) : Infinity;
    const share = (Math.min(fig.x + fig.width, t.x + t.width) - Math.max(fig.x, t.x)) / Math.min(fig.width, t.width);
    if (gap > img.height * 0.12 || share < 0.4 || gap >= bestGap) continue;
    [best, bestGap] = [t, gap];
  }
  return best;
}

/**
 * The page's figures. `boxes` and `img` are in px of the drawn page (`dpi`), `ocr` the page's recognised words if they are known
 * (points, unrotated page space), `ocrText` their page text (offsets of a caption are into it).
 */
export function toFigures(
  boxes: readonly LayoutBox[],
  img: { width: number; height: number },
  page: PageSize,
  dpi: number,
  ocr: { words: readonly OcrWord[]; text: string } | null,
): ScanFigure[] {
  const titles = boxes.filter((b) => TITLE_LABELS.includes(b.label) && b.score >= MEDIUM_SCORE);
  const rect = (b: LayoutBox): PdfRect => displayedPxToPage(b, page, dpi);
  const out: ScanFigure[] = figureBoxes(boxes, img).map((fig) => {
    const title = titleFor(fig, titles, img);
    let label: string | null = null;
    let caption: ScanFigure['caption'] = null;
    let captionRect: PdfRect | null = null;
    if (title) {
      captionRect = rect(title);
      const inside = (ocr?.words ?? []).filter((w) => {
        const cx = w.box.x + w.box.width / 2;
        const cy = w.box.y + w.box.height / 2;
        return cx >= captionRect!.x && cx <= captionRect!.x + captionRect!.width && cy >= captionRect!.y && cy <= captionRect!.y + captionRect!.height;
      });
      const words = inside.sort((a, b) => a.line - b.line || a.box.x - b.box.x).map((w) => w.text);
      const text = words.join(' ');
      label = captionLabel(text);
      const start = text === '' || ocr === null ? -1 : ocr.text.indexOf(words[0]);
      if (start >= 0 && ocr!.text.startsWith(words.join(' '), start)) caption = { start, end: start + text.length, text };
    }
    return {
      kind: fig.label === 'table' ? 'table' : fig.label === 'image' ? 'image' : 'mixed',
      rect: rect(fig),
      label,
      captionRect,
      confidence: fig.score >= HIGH_SCORE ? 'high' : 'medium',
      detector: LAYOUT_DETECTOR,
      caption,
    };
  });
  return out.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}
