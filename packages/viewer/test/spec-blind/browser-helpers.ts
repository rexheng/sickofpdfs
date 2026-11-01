// Browser-side helpers for the spec-blind PdfBackend tests: fixture loading over the dev server, pixel measurements and
// the Worker spy used to inject crashes and hangs.
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { PdfRect } from '../../src/backend/types';

// ---------------------------------------------------------------------------------------------------------------
// Fixtures

const PDF_MAGIC = '%PDF-';

/**
 * Fetches the first candidate (a path from the repo root) that exists and starts with %PDF-. The repo's generated test data
 * is gitignored, so a missing file fails the test with the command that makes it.
 */
export async function fetchPdf(candidates: string[], hint: string): Promise<Uint8Array> {
  for (const path of candidates) {
    const res = await fetch(`/${path}`);
    if (!res.ok) continue;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (new TextDecoder('latin1').decode(bytes.subarray(0, 5)) === PDF_MAGIC) return bytes;
  }
  throw new Error(`test data not found: ${candidates.join(' | ')}. ${hint}`);
}

export async function fetchText(path: string): Promise<string> {
  const res = await fetch(`/${path}`);
  if (!res.ok) throw new Error(`test data not found: ${path} (HTTP ${res.status})`);
  return res.text();
}

export const classifier = (name: string) => fetchPdf([`test-assets/classifier/${name}`], 'Run `pnpm fixtures` at the repo root.');

/** Output of the Phase 0 / ported generators, wherever the repo keeps it. */
export const generated = (name: string, hint: string) =>
  fetchPdf([`test-assets/${name}`, `test-assets/fixtures/${name}`, `test-assets/generated/${name}`, `spikes/phase0/fixtures/out/${name}`], hint);

/** A fresh, transferable copy: open() transfers its argument, so a fixture must never be passed directly. */
export const copyOf = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

// ---------------------------------------------------------------------------------------------------------------
// Pixels

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, composited over white so that transparent and white backgrounds look the same. */
  data: Uint8ClampedArray;
}

export function readPixels(bitmap: ImageBitmap, region?: { x: number; y: number; width: number; height: number }): Pixels {
  const r = region ?? { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
  const canvas = new OffscreenCanvas(r.width, r.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d context');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, r.width, r.height);
  ctx.drawImage(bitmap, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
  return { width: r.width, height: r.height, data: ctx.getImageData(0, 0, r.width, r.height).data };
}

const luminance = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

export interface Ink {
  /** Pixels darker than the threshold. */
  count: number;
  /** count / all pixels. */
  share: number;
  /** Bounding box of the dark pixels in bitmap pixels, or null for a page with none. */
  box: { left: number; top: number; right: number; bottom: number } | null;
  /** True when every pixel is identical (a blank page). */
  uniform: boolean;
}

export function measureInk(px: Pixels, threshold = 128): Ink {
  const { data, width, height } = px;
  let count = 0;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let uniform = true;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = 4 * (y * width + x);
      if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2]) uniform = false;
      if (luminance(data, i) < threshold) {
        count++;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return { count, share: count / (width * height), box: count ? { left, top, right: right + 1, bottom: bottom + 1 } : null, uniform };
}

/** Mean absolute difference of the RGB channels, 0 to 255. */
export function meanAbsDiff(a: Pixels, b: Pixels): number {
  if (a.width !== b.width || a.height !== b.height) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4) sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
  return sum / ((a.data.length / 4) * 3);
}

// ---------------------------------------------------------------------------------------------------------------
// Geometry

export const overlapArea = (a: PdfRect, b: PdfRect) => {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

export const contains = (outer: PdfRect, inner: PdfRect, tol: number) =>
  inner.x >= outer.x - tol && inner.y >= outer.y - tol && inner.x + inner.width <= outer.x + outer.width + tol && inner.y + inner.height <= outer.y + outer.height + tol;

/** Where a point of an unrotated page lands in a bitmap drawn at `scale` with the view turned clockwise by `rotation`. */
export function toBitmap(p: { x: number; y: number }, page: { width: number; height: number }, scale: number, rotation: 0 | 90 | 180 | 270) {
  switch (rotation) {
    case 0:
      return { x: p.x * scale, y: p.y * scale };
    case 90:
      return { x: (page.height - p.y) * scale, y: p.x * scale };
    case 180:
      return { x: (page.width - p.x) * scale, y: (page.height - p.y) * scale };
    case 270:
      return { x: p.y * scale, y: (page.width - p.x) * scale };
  }
}

/** Advance of `text` in standard Helvetica, glyph by glyph (no kerning, as PDF Tj draws it). */
export async function helveticaWidth(text: string, size: number): Promise<number> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  return [...text].reduce((sum, ch) => sum + font.widthOfTextAtSize(ch, size), 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Worker spy: records every Worker the code under test starts, and lets a test make one go silent.

export class SpyWorker extends Worker {
  /** While true, every message posted to the worker is swallowed: the worker looks hung. */
  hung = false;
  terminated = false;
  override postMessage(message: unknown, ...rest: unknown[]): void {
    if (this.hung) return;
    (super.postMessage as (...a: unknown[]) => void)(message, ...rest);
  }
  override terminate(): void {
    this.terminated = true;
    super.terminate();
  }
}

export interface WorkerSpy {
  /** Every worker started since install(), oldest first. */
  readonly spawned: SpyWorker[];
  restore(): void;
}

/** Replaces globalThis.Worker with a recording subclass. Call before the backend starts its worker. */
export function installWorkerSpy(): WorkerSpy {
  const Native = globalThis.Worker;
  const spawned: SpyWorker[] = [];
  class Recording extends SpyWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      spawned.push(this);
    }
  }
  globalThis.Worker = Recording;
  return {
    spawned,
    restore() {
      globalThis.Worker = Native;
      for (const w of spawned) w.terminate();
    },
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
