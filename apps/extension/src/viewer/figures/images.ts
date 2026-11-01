// Pictures of figures and areas, drawn on this computer by the PDF engine (Phase 2, S16). Nothing leaves it.
//
// - Copy image (Ctrl+C on a selected figure or area): a PNG at 2× the size the region has at 100% zoom, as the page is
//   shown (its /Rotate and the view's rotation), with the PDF's own annotations, written to the clipboard.
// - Thumbnails: 64 px pictures for figure cards and the rail's Figures tab, drawn at twice that for sharp screens.
//   A pin or a part of a figure is drawn on its figure's thumbnail, so the card shows which spot the note is about.
//   They are object URLs, cached per document and let go of when it closes.
import type { NormRect } from '@sop/core';
import { type DocHandle, normToPdfRect, type PageSize, type PdfBackend, PT_TO_CSS, type Rotation, turnCorners, turnPoint } from '@sop/viewer';

/** Copy image renders at this many times the region's size at 100% zoom. */
export const COPY_SCALE = 2;
/** A copied picture's longer side stops at this many px (a whole page at 2× is about 1,600 × 2,100). */
const COPY_MAX_SIDE = 4096;
/** Thumbnails are 64 CSS px (--sop-card-thumb) and drawn at 2× for sharp screens. */
export const THUMB_PX = 128;

type RegionBackend = Pick<PdfBackend, 'renderTile'>;

/** A 0–1 point of an unrotated box, where it is once the box is turned clockwise by `r` (the page's one turn). */
function turned(u: number, v: number, r: Rotation): [number, number] {
  const p = turnPoint(u, v, r, 1, 1);
  return [p.x, p.y];
}

/** A 0–1 rect of an unrotated box, once the box is turned by `r`. */
const turnedRect = (n: NormRect, r: Rotation): NormRect => turnCorners(n, r, 1, 1);

/** What is drawn over a thumbnail: a pin or a part of the figure, 0–1 of the region. */
export type ThumbMark = { point: [number, number] } | { rect: NormRect } | null;

/** A token's colour, read from the page's tokens (hex values live only in the token file). */
function tokenColour(name: string): string {
  const v = typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v === '' ? 'currentColor' : v;
}

/**
 * Renders a region of a page into a canvas: `rect` (0–1 of the unrotated crop box) at `scale` device px per point,
 * turned as the page is shown (`/Rotate` plus `viewRotation`).
 */
async function renderRegion(
  backend: RegionBackend,
  doc: DocHandle,
  pageIndex: number,
  page: PageSize,
  rect: NormRect,
  o: { scale: number; viewRotation: Rotation; withAnnotations: boolean },
): Promise<OffscreenCanvas> {
  const r = normToPdfRect(rect, page);
  const region = { x: r.x, y: r.y, width: Math.max(1, r.width), height: Math.max(1, r.height) };
  const bitmap = await backend.renderTile(doc, { pageIndex, scale: o.scale, rect: region, viewRotation: o.viewRotation, withAnnotations: o.withAnnotations });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d canvas context');
    // A white page behind it: a transparent PNG pasted into a dark app would lose its black lines.
    ctx.fillStyle = tokenColour('--viewer-page');
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    return canvas;
  } finally {
    bitmap.close();
  }
}

/** The region as a PNG at COPY_SCALE, as the page is shown. */
export async function regionPng(backend: RegionBackend, doc: DocHandle, pageIndex: number, page: PageSize, rect: NormRect, viewRotation: Rotation): Promise<Blob> {
  const r = normToPdfRect(rect, page);
  const longer = Math.max(1, r.width, r.height);
  const scale = Math.min(COPY_SCALE * PT_TO_CSS, COPY_MAX_SIDE / longer);
  const canvas = await renderRegion(backend, doc, pageIndex, page, rect, { scale, viewRotation, withAnnotations: true });
  return canvas.convertToBlob({ type: 'image/png' });
}

/**
 * Copies the region to the clipboard as a PNG. The clipboard is asked at once, with the picture still being drawn, so
 * the key press that asked for it still counts as the person's own action. Resolves false when the browser refused.
 */
export async function copyRegion(png: () => Promise<Blob>): Promise<boolean> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png() })]);
    return true;
  } catch {
    return false;
  }
}

/** A thumbnail: the region drawn at THUMB_PX on its longer side, with a pin or a part marked on it. */
export async function thumbnailBlob(backend: RegionBackend, doc: DocHandle, pageIndex: number, page: PageSize, rect: NormRect, mark: ThumbMark): Promise<Blob> {
  const r = normToPdfRect(rect, page);
  const scale = Math.min(8, Math.max(1 / 32, THUMB_PX / Math.max(1, r.width, r.height)));
  // As the page is shown in the rail and on cards: its own /Rotate, not the view's rotation.
  const canvas = await renderRegion(backend, doc, pageIndex, page, rect, { scale, viewRotation: 0, withAnnotations: false });
  const ctx = canvas.getContext('2d');
  if (ctx && mark) {
    const w = canvas.width;
    const h = canvas.height;
    const unit = Math.max(w, h) / THUMB_PX; // 1 thumbnail px at 2×
    if ('point' in mark) {
      const [x, y] = turned(mark.point[0], mark.point[1], page.rotation);
      ctx.beginPath();
      ctx.arc(x * w, y * h, 7 * unit, 0, Math.PI * 2);
      ctx.fillStyle = tokenColour('--sop-mark-1-active');
      ctx.fill();
      ctx.lineWidth = 2 * unit;
      ctx.strokeStyle = tokenColour('--sop-card-active-bg');
      ctx.stroke();
    } else {
      const [x0, y0, x1, y1] = turnedRect(mark.rect, page.rotation);
      ctx.lineWidth = 3 * unit;
      ctx.strokeStyle = tokenColour('--sop-area-outline');
      ctx.strokeRect(x0 * w, y0 * h, (x1 - x0) * w, (y1 - y0) * h);
    }
  }
  return canvas.convertToBlob({ type: 'image/png' });
}

/** The thumbnails of one document: object URLs by key, drawn one at a time, let go of when the document closes. */
export interface ThumbnailCache {
  /** The thumbnail's URL, or null while it is drawn (`subscribe` says when it is ready). */
  get(this: void, key: string, make: () => Promise<Blob>): string | null;
  subscribe(this: void, cb: () => void): () => void;
  /** Changes whenever a thumbnail becomes ready. */
  version(this: void): number;
  dispose(this: void): void;
}

/** A thumbnail's key: the page, the region and what is marked on it. */
export function thumbKey(pageIndex: number, rect: NormRect, mark: ThumbMark): string {
  const r = rect.map((v) => v.toFixed(4)).join(',');
  const m = mark === null ? '' : 'point' in mark ? `p${mark.point.map((v) => v.toFixed(3)).join(',')}` : `r${mark.rect.map((v) => v.toFixed(3)).join(',')}`;
  return `${pageIndex}|${r}|${m}`;
}

export function createThumbnailCache(): ThumbnailCache {
  /** A drawn thumbnail's URL, or where it is: being drawn, or failed (the card keeps its empty box; no retry loop). */
  const urls = new Map<string, { url: string } | 'pending' | 'failed'>();
  const queue: { key: string; make: () => Promise<Blob> }[] = [];
  const listeners = new Set<() => void>();
  let version = 0;
  let running = false;
  let disposed = false;

  const pump = () => {
    if (running || disposed) return;
    const next = queue.shift();
    if (!next) return;
    running = true;
    next
      .make()
      .then(
        (blob) => {
          if (disposed) return;
          urls.set(next.key, { url: URL.createObjectURL(blob) });
          version++;
          for (const l of [...listeners]) l();
        },
        () => {
          urls.set(next.key, 'failed');
        },
      )
      .finally(() => {
        running = false;
        pump();
      });
  };

  return {
    get(key, make) {
      const hit = urls.get(key);
      if (hit === undefined) {
        urls.set(key, 'pending');
        queue.push({ key, make });
        pump();
        return null;
      }
      return typeof hit === 'string' ? null : hit.url;
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    version: () => version,
    dispose() {
      disposed = true;
      queue.length = 0;
      for (const u of urls.values()) if (typeof u !== 'string') URL.revokeObjectURL(u.url);
      urls.clear();
      listeners.clear();
    },
  };
}
