// PP-OCR (PaddleOCR) text detection + recognition on onnxruntime-web, written for this spike from the models'
// own inference.yml files. No SDK, no network: model bytes and the ORT module are handed in.
//   det: DB detector (ImageNet-normalised BGR, dynamic H x W, multiple of 32) -> probability map -> DB post-process
//        (threshold, connected components, minimum-area rectangle, unclip) -> rotated line crops
//   rec: CTC recogniser (BGR, (x/255-0.5)/0.5, height 48, dynamic width) -> greedy CTC decode with the model's dictionary
// Word boxes come from the CTC time steps of each character (PaddleOCR's return_word_box idea).
import { convexHull, minAreaRect, readingOrder, rectToBox, type RotRect } from './geom.ts';
import type { OcrEngine, OcrWord, PxBox, RecognizeTimings, RgbaImage } from './types.ts';

type Ort = typeof import('onnxruntime-web');

export interface PpOcrOptions {
  id: string;
  ort: Ort;
  detModel: Uint8Array;
  recModel: Uint8Array;
  /** The rec model's inference.yml text (its PostProcess.character_dict is read from it). */
  recYml: string;
  /** The det model's inference.yml text (thresholds come from it unless overridden). */
  detYml: string;
  backend: 'wasm' | 'webgpu';
  /** Longest side of the detector input in px. The page is shrunk to fit; never enlarged. */
  detMaxSide?: number;
  detThresh?: number;
  boxThresh?: number;
  unclipRatio?: number;
  recBatch?: number;
  /** Round the padded rec width up to a multiple of this (fewer distinct tensor shapes; matters for WebGPU). */
  widthBucket?: number;
  /** Extra ORT session options (e.g. graphOptimizationLevel). */
  sessionOptions?: Record<string, unknown>;
}

const REC_H = 48;
const REC_MAX_W = 3200;

export function parseYmlNumber(yml: string, key: string): number | undefined {
  const m = new RegExp(`^\\s*${key}:\\s*([0-9.]+)\\s*$`, 'm').exec(yml);
  return m ? Number(m[1]) : undefined;
}

/** Reads PostProcess.character_dict from an inference.yml: a list of YAML scalars, one per line, `  - x`. */
export function parseCharacterDict(yml: string): string[] {
  const start = yml.indexOf('character_dict:');
  if (start < 0) throw new Error('no character_dict in the rec model yml');
  const out: string[] = [];
  const lines = yml.slice(start).split('\n').slice(1);
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.startsWith('  - ') && line !== '  -') break;
    const v = line.slice(4);
    if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") out.push(v.slice(1, -1).replace(/''/g, "'"));
    else if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
      out.push(
        v.slice(1, -1).replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_m, e: string) => {
          if (e[0] === 'x' || e[0] === 'u' || e[0] === 'U') return String.fromCodePoint(parseInt(e.slice(1), 16));
          return ({ n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', '/': '/', ' ': ' ' } as Record<string, string>)[e] ?? e;
        }),
      );
    } else out.push(v);
  }
  return out;
}

interface Crop {
  rect: RotRect;
  box: PxBox;
  /** Resized width at height 48. */
  w: number;
  data: Float32Array;
  score: number;
}

interface RecLine {
  rect: RotRect;
  box: PxBox;
  text: string;
  confidence: number;
  chars: { ch: string; t0: number; t1: number; p: number }[];
  /** Width of the unpadded crop in rec pixels and time steps per rec pixel. */
  recW: number;
  stepPx: number;
}

export class PpOcr implements OcrEngine {
  readonly id: string;
  private det!: import('onnxruntime-web').InferenceSession;
  private rec!: import('onnxruntime-web').InferenceSession;
  private dict: string[] = [];
  private hasSpaceClass = false;
  private timings: RecognizeTimings = {};
  private facts: Record<string, unknown> = {};
  private readonly o: Required<Pick<PpOcrOptions, 'detMaxSide' | 'recBatch' | 'widthBucket'>> & PpOcrOptions & { detThresh: number; boxThresh: number; unclipRatio: number };

  constructor(opts: PpOcrOptions) {
    this.id = opts.id;
    this.o = {
      ...opts,
      detMaxSide: opts.detMaxSide ?? 1280,
      recBatch: opts.recBatch ?? 8,
      widthBucket: opts.widthBucket ?? 32,
      detThresh: opts.detThresh ?? parseYmlNumber(opts.detYml, 'thresh') ?? 0.3,
      boxThresh: opts.boxThresh ?? parseYmlNumber(opts.detYml, 'box_thresh') ?? 0.6,
      unclipRatio: opts.unclipRatio ?? parseYmlNumber(opts.detYml, 'unclip_ratio') ?? 1.5,
    };
  }

  async init(): Promise<void> {
    const { ort, backend } = this.o;
    const t0 = performance.now();
    const so = { executionProviders: [backend], graphOptimizationLevel: 'all', ...this.o.sessionOptions } as import('onnxruntime-web').InferenceSession.SessionOptions;
    this.det = await ort.InferenceSession.create(this.o.detModel, so);
    const t1 = performance.now();
    this.rec = await ort.InferenceSession.create(this.o.recModel, so);
    const t2 = performance.now();
    this.dict = parseCharacterDict(this.o.recYml);
    this.facts = {
      backend,
      detInput: this.det.inputNames,
      recInput: this.rec.inputNames,
      dictSize: this.dict.length,
      detThresh: this.o.detThresh,
      boxThresh: this.o.boxThresh,
      unclipRatio: this.o.unclipRatio,
      detMaxSide: this.o.detMaxSide,
      sessionCreateMs: { det: Math.round(t1 - t0), rec: Math.round(t2 - t1) },
    };
  }

  lastTimings() {
    return this.timings;
  }
  info() {
    return this.facts;
  }
  async dispose() {
    await this.det?.release();
    await this.rec?.release();
  }

  async recognize(image: RgbaImage): Promise<OcrWord[]> {
    const T: RecognizeTimings = {};
    let t = performance.now();
    const lap = (name: string) => {
      const n = performance.now();
      T[name] = (T[name] ?? 0) + (n - t);
      t = n;
    };

    // 1. detector input
    const { ort } = this.o;
    const scale = Math.min(1, this.o.detMaxSide / Math.max(image.width, image.height));
    const dw = Math.max(32, Math.round((image.width * scale) / 32) * 32);
    const dh = Math.max(32, Math.round((image.height * scale) / 32) * 32);
    const detData = detInput(image, dw, dh);
    lap('detPrep');
    const detOut = await this.det.run({ [this.det.inputNames[0]!]: new ort.Tensor('float32', detData, [1, 3, dh, dw]) });
    lap('det');
    const prob = detOut[this.det.outputNames[0]!]!.data as Float32Array;

    // 2. DB post-process -> rotated rectangles in image px
    const rects = dbRects(prob, dh, dw, this.o.detThresh, this.o.boxThresh, this.o.unclipRatio, image.width / dw, image.height / dh);
    lap('dbPost');

    // 3. crops at height 48
    const crops: Crop[] = [];
    for (const r of rects) {
      const c = cropLine(image, r.rect);
      if (c) crops.push({ rect: r.rect, box: rectToBox(r.rect), w: c.w, data: c.data, score: r.score });
    }
    lap('crops');

    // 4. recognise in width-sorted batches
    const order = crops.map((_, i) => i).sort((a, b) => crops[a]!.w - crops[b]!.w);
    const lines: (RecLine | null)[] = new Array(crops.length).fill(null);
    for (let i = 0; i < order.length; i += this.o.recBatch) {
      const idx = order.slice(i, i + this.o.recBatch);
      const maxW = Math.max(...idx.map((k) => crops[k]!.w));
      const padW = Math.min(REC_MAX_W, Math.max(this.o.widthBucket, Math.ceil(maxW / this.o.widthBucket) * this.o.widthBucket));
      const batch = new Float32Array(idx.length * 3 * REC_H * padW);
      idx.forEach((k, j) => {
        const c = crops[k]!;
        for (let ch = 0; ch < 3; ch++) {
          for (let y = 0; y < REC_H; y++) {
            const src = c.data.subarray((ch * REC_H + y) * c.w, (ch * REC_H + y + 1) * c.w);
            batch.set(src.length > padW ? src.subarray(0, padW) : src, ((j * 3 + ch) * REC_H + y) * padW);
          }
        }
      });
      lap('recPrep');
      const out = await this.rec.run({ [this.rec.inputNames[0]!]: new ort.Tensor('float32', batch, [idx.length, 3, REC_H, padW]) });
      lap('rec');
      const o = out[this.rec.outputNames[0]!]!;
      const [n, steps, classes] = o.dims as number[];
      const probs = o.data as Float32Array;
      if (i === 0) this.noteClasses(classes!, steps!, padW);
      idx.forEach((k, j) => {
        const c = crops[k]!;
        lines[k] = this.decode(probs.subarray(j * steps! * classes!, (j + 1) * steps! * classes!), steps!, classes!, c, Math.min(c.w, padW), padW / steps!);
      });
      void n;
      lap('ctc');
    }

    // 5. reading order, words
    const kept = lines.filter((l): l is RecLine => !!l && l.text.trim().length > 0);
    const ordered = readingOrder(kept.map((l) => ({ ...l, h: l.rect.h })), image.width);
    const words: OcrWord[] = [];
    ordered.forEach(({ item, block }, lineNo) => {
      for (const w of splitWords(item)) words.push({ ...w, line: lineNo, block });
    });
    lap('words');
    T.total = Object.values(T).reduce((a, b) => a + b, 0);
    T.lines = kept.length;
    this.timings = T;
    return words;
  }

  private noteClasses(classes: number, steps: number, padW: number) {
    // class 0 is the CTC blank; PaddleOCR appends ' ' to the dictionary when the model has one more class than dict + blank.
    this.hasSpaceClass = classes === this.dict.length + 2;
    this.facts.recClasses = classes;
    this.facts.spaceClassAppended = this.hasSpaceClass;
    this.facts.recStepPx = padW / steps;
    if (classes !== this.dict.length + 1 && classes !== this.dict.length + 2) this.facts.classMismatch = `dict ${this.dict.length} vs classes ${classes}`;
  }

  private decode(p: Float32Array, steps: number, classes: number, crop: Crop, recW: number, stepPx: number): RecLine {
    const chars: RecLine['chars'] = [];
    let prev = -1;
    for (let s = 0; s < steps; s++) {
      let best = 0;
      let bv = -Infinity;
      for (let c = 0; c < classes; c++) {
        const v = p[s * classes + c]!;
        if (v > bv) {
          bv = v;
          best = c;
        }
      }
      if (best !== 0 && best !== prev) {
        const ch = best - 1 < this.dict.length ? this.dict[best - 1]! : ' ';
        chars.push({ ch, t0: s, t1: s, p: bv });
      } else if (best !== 0 && best === prev && chars.length) {
        chars[chars.length - 1]!.t1 = s;
      }
      prev = best;
    }
    const text = chars.map((c) => c.ch).join('');
    const confidence = chars.length ? chars.reduce((a, c) => a + c.p, 0) / chars.length : 0;
    return { rect: crop.rect, box: crop.box, text, confidence, chars, recW, stepPx };
  }
}

/** Words of one recognised line with boxes from CTC time steps. Time-step centres -> x in the line's own (rotated) frame. */
function splitWords(line: RecLine): Omit<OcrWord, 'line' | 'block'>[] {
  const { chars, rect, recW, stepPx } = line;
  if (!chars.length) return [];
  const groups: { ch: string; t0: number; t1: number; p: number }[][] = [[]];
  for (const c of chars) {
    if (c.ch === ' ' || c.ch === '　') groups.push([]);
    else groups[groups.length - 1]!.push(c);
  }
  const lineW = rect.w;
  const toLineX = (t: number) => Math.max(0, Math.min(lineW, ((t * stepPx) / recW) * lineW));
  // average pitch (px per character) over the line, for half-character margins
  const all = chars.filter((c) => c.ch !== ' ');
  const centre = (c: { t0: number; t1: number }) => (c.t0 + c.t1 + 1) / 2;
  const pitch = all.length > 1 ? (centre(all[all.length - 1]!) - centre(all[0]!)) / (all.length - 1) : 2;
  const out: Omit<OcrWord, 'line' | 'block'>[] = [];
  for (const g of groups) {
    if (!g.length) continue;
    const first = g[0]!;
    const last = g[g.length - 1]!;
    const wordPitch = g.length > 1 ? (centre(last) - centre(first)) / (g.length - 1) : pitch;
    const half = Math.min(wordPitch, pitch * 1.6) / 2;
    const x0 = toLineX(centre(first) - half);
    const x1 = toLineX(centre(last) + half);
    // the word's four corners in the line frame -> axis-aligned box in image px
    const pts = [
      [x0, 0],
      [x1, 0],
      [x1, rect.h],
      [x0, rect.h],
    ].map(([u, v]) => ({
      x: rect.cx + (u! - rect.w / 2) * rect.ux + (v! - rect.h / 2) * rect.vx,
      y: rect.cy + (u! - rect.w / 2) * rect.uy + (v! - rect.h / 2) * rect.vy,
    }));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    out.push({
      text: g.map((c) => c.ch).join(''),
      box: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
      confidence: g.reduce((a, c) => a + c.p, 0) / g.length,
    });
  }
  return out;
}

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
        const v = (d[i00 + k]! * (1 - wx) + d[i01 + k]! * wx) * (1 - wy) + (d[i10 + k]! * (1 - wx) + d[i11 + k]! * wx) * wy;
        out[c * plane + o] = (v / 255 - mean[c]!) / std[c]!;
      }
    }
  }
  return out;
}

interface DbRect {
  rect: RotRect;
  score: number;
}

/**
 * DB post-processing: threshold the probability map, label 8-connected components, take each component's minimum-area
 * rectangle, score it (mean probability inside), unclip by area * ratio / perimeter, and scale to image px.
 */
export function dbRects(prob: Float32Array, H: number, W: number, thresh: number, boxThresh: number, unclip: number, sx: number, sy: number): DbRect[] {
  const bit = new Uint8Array(H * W);
  for (let i = 0; i < bit.length; i++) bit[i] = prob[i]! > thresh ? 1 : 0;
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
      const p = stack[--sp]!;
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
        sum += prob[y * W + x]!;
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
        const val = (d[i00 + k]! * (1 - wx) + d[i01 + k]! * wx) * (1 - wy) + (d[i10 + k]! * (1 - wx) + d[i11 + k]! * wx) * wy;
        data[c * plane + y * w + x] = (val / 255 - 0.5) / 0.5;
      }
    }
  }
  return { w, data };
}
