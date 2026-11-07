// Selection and mark rectangles on a recognised page (the OCR side of PageTextProvider.rects): the union of the letters'
// boxes on each line the range touches, one rectangle a line, in reading order, as PDFium's merged line rects are.
// Pure: no DOM, no engine.
import type { PdfRect, Rotation } from '../../../viewer/src/backend/types';
import { ocrLines, ocrToPageGlyphs } from './to-glyphs';
import type { OcrPageResult } from './types';

/** Merged line rects for chars [start, start + count) of a recognised page, in points. */
export function ocrRects(r: OcrPageResult, start: number, count: number, rotation: Rotation = 0): PdfRect[] {
  const { glyphs } = ocrToPageGlyphs(r, { rotation });
  const end = start + Math.max(0, count);
  const out: PdfRect[] = [];
  for (const line of ocrLines(r, rotation)) {
    const from = Math.max(start, line.start);
    const to = Math.min(end, line.end);
    if (from >= to) continue;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = from; i < to; i++) {
      const b = glyphs[i]!.box;
      if (glyphs[i]!.generated || b.width <= 0 || b.height <= 0) continue;
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.width);
      y1 = Math.max(y1, b.y + b.height);
    }
    if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  }
  return out;
}
