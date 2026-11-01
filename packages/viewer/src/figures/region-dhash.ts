// The look of a page region, for figure and area anchors (research 06 §5): the region rendered small and averaged down to
// a 9 × 8 grid of grey values, which S3's dHash64 (packages/core/src/anchoring/dhash.ts) turns into a 64-bit hash. The
// region is drawn in unrotated page space (the view and the page's /Rotate cancelled), the space NormRect is in, without
// annotations, so the hash does not change with the viewer's rotation or with marks drawn into the page.
import type { NormRect } from '@sop/core';
import type { DocHandle, PageSize, PdfBackend, PdfRect, Rotation } from '../backend/types';

/** The grid dHash64 takes: 9 columns by 8 rows, row-major (grey[row * 9 + column]), 0 black to 255 white. */
export const DHASH_COLUMNS = 9;
export const DHASH_ROWS = 8;
/** The render aims at this many pixels per grid cell on each side before averaging. */
const PX_PER_CELL = 8;
/** Scale limits (device px per point) for the region's render. */
const MIN_SCALE = 1 / 32;
const MAX_SCALE = 8;
/** renderTile's limit on a side (sop-native MAX_TILE_SIDE). */
const MAX_SIDE = 16_384;

/** A NormRect (0–1 of the crop box) as points on a page of that size, clipped to the page. */
export function normToPdfRect(rect: NormRect, page: Pick<PageSize, 'width' | 'height'>): PdfRect {
  const clip = (v: number) => Math.min(1, Math.max(0, v));
  const [x0, y0, x1, y1] = rect.map(clip) as NormRect;
  const left = Math.min(x0, x1) * page.width;
  const top = Math.min(y0, y1) * page.height;
  return { x: left, y: top, width: Math.abs(x1 - x0) * page.width, height: Math.abs(y1 - y0) * page.height };
}

/**
 * The region's 9 × 8 grey grid. Each cell is the mean luminance (Rec. 601, over white where the render is transparent)
 * of the pixels it covers, pixels on a cell boundary split by area. A region with no area renders as a 1 pt square at
 * its corner.
 */
export async function regionGrey9x8(
  backend: Pick<PdfBackend, 'renderTile'>,
  doc: DocHandle,
  pageIndex: number,
  page: PageSize,
  rect: NormRect,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const r = normToPdfRect(rect, page);
  const region: PdfRect = { x: Math.min(r.x, page.width - 1), y: Math.min(r.y, page.height - 1), width: Math.max(1, r.width), height: Math.max(1, r.height) };
  const wanted = Math.max((DHASH_COLUMNS * PX_PER_CELL) / region.width, (DHASH_ROWS * PX_PER_CELL) / region.height);
  const scale = Math.min(MAX_SCALE, MAX_SIDE / Math.max(region.width, region.height), Math.max(MIN_SCALE, wanted));
  const bitmap = await backend.renderTile(doc, { pageIndex, scale, rect: region, viewRotation: ((360 - page.rotation) % 360) as Rotation, withAnnotations: false }, signal);
  try {
    return averageGrey(bitmap);
  } finally {
    bitmap.close();
  }
}

/** The bitmap's luminance averaged into the 9 × 8 grid (see regionGrey9x8). */
function averageGrey(bitmap: ImageBitmap): Uint8Array {
  const { width, height } = bitmap;
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('regionGrey9x8: no 2d canvas context');
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, width, height).data;
  const xs = spans(width, DHASH_COLUMNS);
  const ys = spans(height, DHASH_ROWS);
  const sum = new Float64Array(DHASH_COLUMNS * DHASH_ROWS);
  const weight = new Float64Array(DHASH_COLUMNS * DHASH_ROWS);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const q = 4 * (y * width + x);
      const alpha = (data[q + 3] ?? 255) / 255;
      // Over white: a transparent pixel reads 255.
      const grey = (0.299 * (data[q] ?? 0) + 0.587 * (data[q + 1] ?? 0) + 0.114 * (data[q + 2] ?? 0)) * alpha + 255 * (1 - alpha);
      for (const [row, wy] of ys[y] ?? []) {
        for (const [column, wx] of xs[x] ?? []) {
          const cell = row * DHASH_COLUMNS + column;
          sum[cell] = (sum[cell] ?? 0) + grey * wx * wy;
          weight[cell] = (weight[cell] ?? 0) + wx * wy;
        }
      }
    }
  }
  const grey = new Uint8Array(DHASH_COLUMNS * DHASH_ROWS);
  grey.forEach((_, cell) => {
    const w = weight[cell] ?? 0;
    grey[cell] = w > 0 ? Math.round((sum[cell] ?? 0) / w) : 255;
  });
  return grey;
}

/** For each of `n` pixels along an axis split into `cells` equal cells: the cells it overlaps, with the overlap. */
function spans(n: number, cells: number): [cell: number, weight: number][][] {
  const out: [number, number][][] = [];
  for (let i = 0; i < n; i++) {
    const from = (i * cells) / n;
    const to = ((i + 1) * cells) / n;
    const parts: [number, number][] = [];
    for (let c = Math.floor(from); c < Math.min(cells, Math.ceil(to)); c++) {
      const w = Math.min(to, c + 1) - Math.max(from, c);
      if (w > 0) parts.push([c, w]);
    }
    out.push(parts);
  }
  return out;
}
