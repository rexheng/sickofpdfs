// PP-OCR's image preparation and the DB detector's post-processing, ported from the Phase 7.0 bake-off
// (spikes/phase7-ocr/src/ocr/ppocr.ts, measured in docs/spikes/phase7-ocr-report.md). Pure functions over RGBA pixels, no DOM.
//   det: ImageNet-normalised BGR, planar, the page shrunk so its longest side fits (a multiple of 32)
//   DB:  threshold the probability map, 8-connected components, minimum-area rectangle, score, unclip, back to image px
//   rec: each line cropped along its (rotated) rectangle to 48 px high, (x/255 - 0.5)/0.5, BGR, planar
import { convexHull, minAreaRect, type RotRect } from './geom';

/** RGBA, 4 bytes a pixel, row-major. */
export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** The recogniser's line height in px. */
export const REC_H = 48;
/** The widest line crop the recogniser is given. */
export const REC_MAX_W = 3200;

/** Detector input: bilinear resize to dw x dh, ImageNet mean/std, BGR order, planar (CHW). */
export function detInput(img: RgbaImage, dw: number, dh: number): Float32Array {
  const out = new Float32Array(3 * dh * dw);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const sx = img.width / dw;
  const sy = img.height / dh;
  const plane = dh * dw;
  const d = img.data;
  const W = img.width;
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = fy | 0;
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(W - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = fx | 0;
      const x1 = Math.min(W - 1, x0 + 1);
      const wx = fx - x0;
      const i00 = (y0 * W + x0) * 4;
      const i01 = (y0 * W + x1) * 4;
      const i10 = (y1 * W + x0) * 4;
      const i11 = (y1 * W + x1) * 4;
      const o = y * dw + x;
      for (let c = 0; c < 3; c++) {
        // BGR: channel 0 of the tensor is blue (RGBA offset 2)
        const k = 2 - c;
        const v = (d[i00 + k] * (1 - wx) + d[i01 + k] * wx) * (1 - wy) + (d[i10 + k] * (1 - wx) + d[i11 + k] * wx) * wy;
        out[c * plane + o] = (v / 255 - mean[c]) / std[c];
      }
    }
  }
  return out;
}

export interface DbRect {
  rect: RotRect;
  score: number;
}

/**
 * DB post-processing: threshold the probability map, label 8-connected components, take each component's minimum-area
 * rectangle, score it (mean probability inside), unclip by area * ratio / perimeter, and scale to image px.
 */
export function dbRects(prob: Float32Array, H: number, W: number, thresh: number, boxThresh: number, unclip: number, sx: number, sy: number): DbRect[] {
  const bit = new Uint8Array(H * W);
  for (let i = 0; i < bit.length; i++) bit[i] = prob[i] > thresh ? 1 : 0;
  const seen = new Uint8Array(H * W);
  const stack = new Int32Array(H * W);
  const rects: DbRect[] = [];
  for (let start = 0; start < bit.length; start++) {
    if (!bit[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    const bx: number[] = [];
    const by: number[] = [];
    let area = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const y = (p / W) | 0;
      const x = p - y * W;
      area++;
      let edge = false;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const xx = x + dx;
          if (yy < 0 || yy >= H || xx < 0 || xx >= W || !bit[yy * W + xx]) {
            if (dx === 0 || dy === 0) edge = true;
            continue;
          }
          const q = yy * W + xx;
          if (!seen[q]) {
            seen[q] = 1;
            stack[sp++] = q;
          }
        }
      }
      if (edge) {
        bx.push(x);
        by.push(y);
      }
    }
    if (area < 6) continue;
    const r = minAreaRect(convexHull(bx, by));
    if (!r || Math.min(r.w, r.h) < 3) continue;
    const score = rectScore(prob, H, W, r);
    if (score < boxThresh) continue;
    const d = (r.w * r.h * unclip) / (2 * (r.w + r.h));
    const grown: RotRect = { ...r, w: r.w + 2 * d, h: r.h + 2 * d };
    if (Math.min(grown.w, grown.h) < 5) continue;
    // to image px (anisotropic scale only matters for the centre and sizes along the axes; scans keep sx ~ sy)
    const s = (sx + sy) / 2;
    rects.push({ rect: { ...grown, cx: grown.cx * sx, cy: grown.cy * sy, w: grown.w * s, h: grown.h * s }, score });
  }
  return rects;
}

function rectScore(prob: Float32Array, H: number, W: number, r: RotRect): number {
  const hw = (Math.abs(r.ux) * r.w + Math.abs(r.vx) * r.h) / 2;
  const hh = (Math.abs(r.uy) * r.w + Math.abs(r.vy) * r.h) / 2;
  const x0 = Math.max(0, Math.floor(r.cx - hw));
  const x1 = Math.min(W - 1, Math.ceil(r.cx + hw));
  const y0 = Math.max(0, Math.floor(r.cy - hh));
  const y1 = Math.min(H - 1, Math.ceil(r.cy + hh));
  let sum = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const u = (x + 0.5 - r.cx) * r.ux + (y + 0.5 - r.cy) * r.uy;
      const v = (x + 0.5 - r.cx) * r.vx + (y + 0.5 - r.cy) * r.vy;
      if (Math.abs(u) <= r.w / 2 && Math.abs(v) <= r.h / 2) {
        sum += prob[y * W + x];
        n++;
      }
    }
  }
  return n ? sum / n : 0;
}

/** Samples the rotated rectangle into a 48-high, aspect-preserving, normalised BGR planar crop. */
export function cropLine(img: RgbaImage, r: RotRect): { w: number; data: Float32Array } | null {
  if (r.w < 2 || r.h < 2) return null;
  const w = Math.max(8, Math.min(REC_MAX_W, Math.ceil((REC_H * r.w) / r.h)));
  const data = new Float32Array(3 * REC_H * w);
  const plane = REC_H * w;
  const d = img.data;
  const W = img.width;
  const H = img.height;
  const stepU = r.w / w;
  const stepV = r.h / REC_H;
  for (let y = 0; y < REC_H; y++) {
    const v = (y + 0.5) * stepV - r.h / 2;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * stepU - r.w / 2;
      const fx = Math.min(W - 1, Math.max(0, r.cx + u * r.ux + v * r.vx - 0.5));
      const fy = Math.min(H - 1, Math.max(0, r.cy + u * r.uy + v * r.vy - 0.5));
      const x0 = fx | 0;
      const y0 = fy | 0;
      const x1 = Math.min(W - 1, x0 + 1);
      const y1 = Math.min(H - 1, y0 + 1);
      const wx = fx - x0;
      const wy = fy - y0;
      const i00 = (y0 * W + x0) * 4;
      const i01 = (y0 * W + x1) * 4;
      const i10 = (y1 * W + x0) * 4;
      const i11 = (y1 * W + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const k = 2 - c;
        const val = (d[i00 + k] * (1 - wx) + d[i01 + k] * wx) * (1 - wy) + (d[i10 + k] * (1 - wx) + d[i11 + k] * wx) * wy;
        data[c * plane + y * w + x] = (val / 255 - 0.5) / 0.5;
      }
    }
  }
  return { w, data };
}
