// The layout model's output: `[M, 6]` rows of `[class, score, x1, y1, x2, y2]` (boxes in px of the image given) and the count of
// valid rows. NMS is in the graph. Only the rows that are real, inside the image and not empty are kept.
import { LAYOUT_LABELS, type LayoutBox } from './models';

export function decodeLayout(rows: ArrayLike<number>, count: number, imgW: number, imgH: number): LayoutBox[] {
  const boxes: LayoutBox[] = [];
  const n = Math.min(count, Math.floor(rows.length / 6));
  for (let i = 0; i < n; i++) {
    const [cls, score, x1, y1, x2, y2] = [0, 1, 2, 3, 4, 5].map((k) => Number(rows[i * 6 + k]));
    const label = LAYOUT_LABELS[cls];
    if (label === undefined || !Number.isFinite(score + x1 + y1 + x2 + y2)) continue;
    const x = Math.max(0, Math.min(x1, x2));
    const y = Math.max(0, Math.min(y1, y2));
    const width = Math.min(imgW, Math.max(x1, x2)) - x;
    const height = Math.min(imgH, Math.max(y1, y2)) - y;
    if (width < 2 || height < 2) continue;
    boxes.push({ label, score, x, y, width, height });
  }
  return boxes;
}
