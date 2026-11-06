// Draws one region of a page as a picture for Claude, locally, through PdfBackend.renderTile (contracts section 6;
// research 06 section 7.1). Nothing leaves the machine here: the caller decides whether the picture is sent.
//
// What it does, in order:
// 1. Reads the page's glyphs inside the region: the smallest text sets the scale (18 px tall at least, between 150 and
//    300 dpi), and the way the text runs sets the rotation, so a sideways table is turned upright.
// 2. Reads the page's objects inside the region: images that cover over 60% make it a photograph (JPEG), and a region
//    that is only a picture is never drawn above the picture's own pixels.
// 3. Lowers the scale until the picture costs at most `maxTokens` and its long edge is at most 2,576 px.
// 4. Draws the mark (a 3 px magenta outline or a ring) on the picture, and encodes PNG, or JPEG at 0.9.
import { chooseFormat, fitScale, intersect, MAX_IMAGE_BYTES, MIN_FONT_PT, smallestFont, visualTokens, wantedScale } from '@sop/core';
import type { RegionImage } from '@sop/core';
import type { DocHandle, PdfBackend, PdfRect, Rotation } from '../backend/types';

export type { RegionImage };

export interface RenderRegionOptions {
  /** 1,600; 3,200 for Think harder; 4,784 for scans. */
  maxTokens: number;
  /** The marked sub-area (outlined) or pin (a ring), in points, unrotated page space, y down. */
  mark?: { rect?: PdfRect; point?: [number, number] };
  format?: 'auto' | 'png' | 'jpeg';
  /** The page's /Rotate. renderTile adds it to the view rotation, and the mark has to follow. Default 0. */
  pageRotation?: Rotation;
  /** A scanned page: JPEG, and the picture is never drawn above its own pixels. */
  scan?: boolean;
  /** Draw the long edge no longer than this many px (a context page image of a scan is 1,092). */
  maxEdge?: number;
  /** The enlarged crop of a small mark: drawn as sharp as the budget allows (up to 600 dpi), not capped at 300. */
  enlarge?: boolean;
  signal?: AbortSignal;
}

/** The tint of the mark; 3 px wide on the picture. */
const MARK_COLOR = '#e6007e';
const MARK_PX = 3;
const JPEG_QUALITY = 0.9;

type Backend = Pick<PdfBackend, 'renderTile' | 'getPageGlyphs' | 'listPageObjects'>;

export async function renderRegion(be: Backend, doc: DocHandle, pageIndex: number, rect: PdfRect, o: RenderRegionOptions): Promise<RegionImage> {
  const region = rect;
  const pageRotation = o.pageRotation ?? 0;

  const [glyphs, objects] = await Promise.all([
    be.getPageGlyphs(doc, pageIndex).catch(() => null),
    be.listPageObjects(doc, pageIndex, { recurseForms: true }).catch(() => null),
  ]);

  // 1. Text inside the region: the smallest size and the way it runs.
  const sizes: number[] = [];
  const turns = new Map<number, number>();
  let textChars = 0;
  for (const g of glyphs?.glyphs ?? []) {
    if (g.generated || g.fontSize < MIN_FONT_PT || /\s/.test(g.text)) continue;
    const cx = g.box.x + g.box.width / 2;
    const cy = g.box.y + g.box.height / 2;
    if (cx < region.x || cx > region.x + region.width || cy < region.y || cy > region.y + region.height) continue;
    textChars++;
    sizes.push(g.fontSize);
    const angle = ((g.angle % 360) + 360) % 360;
    const nearest = Math.round(angle / 90);
    if (Math.abs(angle - nearest * 90) <= 20) turns.set(nearest % 4, (turns.get(nearest % 4) ?? 0) + 1);
  }
  const smallest = smallestFont(sizes);
  let upright = 0;
  if (textChars >= 5) {
    let best = 0;
    for (const [quarter, n] of turns) if (n > best) { best = n; upright = quarter * 90; }
  }
  // The text already shows at (its angle + the page's /Rotate); turn the view the rest of the way round.
  const viewRotation = ((360 - ((upright + pageRotation) % 360)) % 360) as Rotation;
  const totalRotation = ((pageRotation + viewRotation) % 360) as Rotation;

  // 2. Pictures inside the region.
  const area = Math.max(1, region.width * region.height);
  let imageArea = 0;
  let nativePxPerPt = 0;
  let otherInk = 0;
  for (const obj of objects?.objects ?? []) {
    const hit = intersect(obj.bounds, region);
    if (!hit) continue;
    if (obj.type === 'image' && obj.image) {
      imageArea += hit.width * hit.height;
      nativePxPerPt = Math.max(nativePxPerPt, obj.image.pixelWidth / Math.max(1, obj.bounds.width));
    } else if (obj.type === 'path' || obj.type === 'shading') {
      otherInk++;
    }
  }
  const photoCoverage = Math.min(1, imageArea / area);
  const rasterOnly = nativePxPerPt > 0 && textChars === 0 && otherInk === 0;

  // 3. How big.
  const swap = totalRotation === 90 || totalRotation === 270;
  const w = swap ? region.height : region.width;
  const h = swap ? region.width : region.height;
  const native = rasterOnly || o.scan ? (nativePxPerPt > 0 ? nativePxPerPt : null) : null;
  const wanted = o.enlarge ? Math.min(Math.max(wantedScale(smallest), 600 / 72), native ?? Infinity) : wantedScale(smallest, native);
  const fit = fitScale(w, h, wanted, o.maxTokens, o.maxEdge);

  const bitmap = await be.renderTile(doc, { pageIndex, scale: fit.scale, rect: region, viewRotation, withAnnotations: true }, o.signal);
  try {
    const width = bitmap.width;
    const height = bitmap.height;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('renderRegion: no 2d canvas context');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0);
    if (o.mark) drawMark(ctx, region, o.mark, fit.scale, totalRotation);

    let format = chooseFormat({ photoCoverage, scan: o.scan === true, ...(o.format ? { format: o.format } : {}) });
    let blob = await canvas.convertToBlob(format === 'png' ? { type: 'image/png' } : { type: 'image/jpeg', quality: JPEG_QUALITY });
    // Under 3.75 MB raw. A picture that is too big as PNG goes JPEG (unless asked for PNG); then smaller.
    if (blob.size > MAX_IMAGE_BYTES && o.format !== 'png' && format === 'png') {
      format = 'jpeg';
      blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    }
    for (let shrink = 0.8; blob.size > MAX_IMAGE_BYTES && shrink > 0.3; shrink -= 0.15) {
      const small = new OffscreenCanvas(Math.max(1, Math.round(width * shrink)), Math.max(1, Math.round(height * shrink)));
      small.getContext('2d')?.drawImage(canvas, 0, 0, small.width, small.height);
      blob = await small.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
      format = 'jpeg';
      if (blob.size <= MAX_IMAGE_BYTES) {
        return { blob, mediaType: 'image/jpeg', width: small.width, height: small.height, scale: fit.scale * shrink, visualTokens: visualTokens(small.width, small.height) };
      }
    }
    return { blob, mediaType: format === 'png' ? 'image/png' : 'image/jpeg', width, height, scale: fit.scale, visualTokens: visualTokens(width, height) };
  } finally {
    bitmap.close();
  }
}

/** A point of the region (points from its top-left, unrotated) on the picture, turned as the page is drawn. */
function toPicture(dx: number, dy: number, w: number, h: number, rotation: Rotation, scale: number): [number, number] {
  const [x, y] = rotation === 90 ? [h - dy, dx] : rotation === 180 ? [w - dx, h - dy] : rotation === 270 ? [dy, w - dx] : [dx, dy];
  return [x * scale, y * scale];
}

function drawMark(ctx: OffscreenCanvasRenderingContext2D, region: PdfRect, mark: NonNullable<RenderRegionOptions['mark']>, scale: number, rotation: Rotation): void {
  const stroke = (draw: () => void) => {
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#fff'; // a white halo, so the outline shows on dark parts of a figure
    ctx.lineWidth = MARK_PX + 3;
    draw();
    ctx.strokeStyle = MARK_COLOR;
    ctx.lineWidth = MARK_PX;
    draw();
  };
  if (mark.rect) {
    const a = toPicture(mark.rect.x - region.x, mark.rect.y - region.y, region.width, region.height, rotation, scale);
    const b = toPicture(mark.rect.x + mark.rect.width - region.x, mark.rect.y + mark.rect.height - region.y, region.width, region.height, rotation, scale);
    const x = Math.min(a[0], b[0]);
    const y = Math.min(a[1], b[1]);
    stroke(() => ctx.strokeRect(x, y, Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])));
  }
  if (mark.point) {
    const [x, y] = toPicture(mark.point[0] - region.x, mark.point[1] - region.y, region.width, region.height, rotation, scale);
    stroke(() => {
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.stroke();
    });
  }
}
