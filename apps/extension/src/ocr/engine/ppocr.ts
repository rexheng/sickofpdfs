// PP-OCR (PaddleOCR) text detection and recognition on onnxruntime-web, ported from the Phase 7.0 bake-off
// (spikes/phase7-ocr/src/ocr/ppocr.ts; the engine and settings are its Decision: PP-OCRv6 tiny, wasm, one thread, detector side
// 1280). No SDK and no network: the model bytes and the runtime module are handed in by the worker (ocr.worker.ts).
//   det: DB detector → probability map → rotated line rectangles (preprocess.ts)
//   rec: CTC recogniser on 48 px line crops, in width-sorted batches → greedy CTC decode with the model's own dictionary
// Word boxes come from the CTC time steps of each character. Lines are put in reading order by an XY-cut (geom.ts).
// Between two recognition batches the caller may stop the page (`shouldStop`): a page the reader scrolled away from gives
// its turn to the one now on screen within a batch (about half a second), not after the whole page.
import { readingOrder, rectToBox, type PxBox, type RotRect } from './geom';
import { cropLine, dbRects, detInput, REC_H, REC_MAX_W, type RgbaImage } from './preprocess';

type Ort = typeof import('onnxruntime-web');
type Session = import('onnxruntime-web').InferenceSession;

/** A recognised word in pixels of the image (ocr.worker.ts turns these into points). */
export interface PxWord {
  text: string;
  box: PxBox;
  confidence: number;
  line: number;
  block: number;
}

export interface PpOcrOptions {
  ort: Ort;
  detModel: Uint8Array;
  recModel: Uint8Array;
  /** The rec model's inference.yml (its PostProcess.character_dict). */
  recYml: string;
  /** The det model's inference.yml (its thresholds). */
  detYml: string;
  /** Longest side of the detector input in px; the page is shrunk to fit, never enlarged. */
  detMaxSide: number;
  recBatch: number;
  /** The padded rec width is a multiple of this (fewer distinct tensor shapes). */
  widthBucket: number;
}

/** Thrown when `shouldStop` says so between two batches. */
export class OcrStopped extends Error {
  override readonly name = 'AbortError';
  constructor() {
    super('The page was stopped.');
  }
}

export function parseYmlNumber(yml: string, key: string): number | undefined {
  const m = new RegExp(`^\\s*${key}:\\s*([0-9.]+)\\s*$`, 'm').exec(yml);
  return m ? Number(m[1]) : undefined;
}

/** PostProcess.character_dict of an inference.yml: a YAML list of scalars, one per line (`  - x`). */
export function parseCharacterDict(yml: string): string[] {
  const start = yml.indexOf('character_dict:');
  if (start < 0) throw new Error('no character_dict in the rec model yml');
  const out: string[] = [];
  for (const raw of yml.slice(start).split('\n').slice(1)) {
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
}

interface RecLine {
  rect: RotRect;
  box: PxBox;
  text: string;
  confidence: number;
  chars: { ch: string; t0: number; t1: number; p: number }[];
  /** Width of the unpadded crop in rec pixels, and pixels per time step. */
  recW: number;
  stepPx: number;
}

/** A recognised line kept for the page: it has a letter or a digit (a plot's tick marks and rules give lines of symbols). */
const KEEP_LINE = /[\p{L}\p{N}]/u;

export class PpOcr {
  private det!: Session;
  private rec!: Session;
  private dict: string[] = [];
  private readonly thresh: number;
  private readonly boxThresh: number;
  private readonly unclip: number;

  constructor(private readonly o: PpOcrOptions) {
    this.thresh = parseYmlNumber(o.detYml, 'thresh') ?? 0.3;
    this.boxThresh = parseYmlNumber(o.detYml, 'box_thresh') ?? 0.6;
    this.unclip = parseYmlNumber(o.detYml, 'unclip_ratio') ?? 1.5;
  }

  async init(): Promise<void> {
    const so = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' } as import('onnxruntime-web').InferenceSession.SessionOptions;
    this.det = await this.o.ort.InferenceSession.create(this.o.detModel, so);
    this.rec = await this.o.ort.InferenceSession.create(this.o.recModel, so);
    this.dict = parseCharacterDict(this.o.recYml);
  }

  async dispose(): Promise<void> {
    await this.det?.release();
    await this.rec?.release();
  }

  /** The page's words in reading order, in image px. `shouldStop` is asked between batches. */
  async recognize(image: RgbaImage, shouldStop: () => boolean = () => false): Promise<{ words: PxWord[]; ms: Record<string, number> }> {
    const ms: Record<string, number> = {};
    let t = performance.now();
    const lap = (name: string) => {
      const n = performance.now();
      ms[name] = (ms[name] ?? 0) + (n - t);
      t = n;
    };
    const { ort } = this.o;

    // 1. detector
    const scale = Math.min(1, this.o.detMaxSide / Math.max(image.width, image.height));
    const dw = Math.max(32, Math.round((image.width * scale) / 32) * 32);
    const dh = Math.max(32, Math.round((image.height * scale) / 32) * 32);
    const detOut = await this.det.run({ [this.det.inputNames[0]!]: new ort.Tensor('float32', detInput(image, dw, dh), [1, 3, dh, dw]) });
    lap('det');
    if (shouldStop()) throw new OcrStopped();
    const prob = detOut[this.det.outputNames[0]!]!.data as Float32Array;
    const rects = dbRects(prob, dh, dw, this.thresh, this.boxThresh, this.unclip, image.width / dw, image.height / dh);

    // 2. line crops at height 48
    const crops: Crop[] = [];
    for (const r of rects) {
      const c = cropLine(image, r.rect);
      if (c) crops.push({ rect: r.rect, box: rectToBox(r.rect), w: c.w, data: c.data });
    }
    lap('crops');

    // 3. recognition in width-sorted batches
    const order = crops.map((_, i) => i).sort((a, b) => crops[a]!.w - crops[b]!.w);
    const lines: (RecLine | null)[] = new Array(crops.length).fill(null);
    for (let i = 0; i < order.length; i += this.o.recBatch) {
      if (shouldStop()) throw new OcrStopped();
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
      const out = await this.rec.run({ [this.rec.inputNames[0]!]: new ort.Tensor('float32', batch, [idx.length, 3, REC_H, padW]) });
      const o = out[this.rec.outputNames[0]!]!;
      const [, steps, classes] = o.dims as number[];
      const probs = o.data as Float32Array;
      idx.forEach((k, j) => {
        const c = crops[k]!;
        lines[k] = this.decode(probs.subarray(j * steps! * classes!, (j + 1) * steps! * classes!), steps!, classes!, c, Math.min(c.w, padW), padW / steps!);
      });
      lap('rec');
    }

    // 4. reading order, then words
    const kept = lines.filter((l): l is RecLine => !!l && KEEP_LINE.test(l.text));
    const ordered = readingOrder(
      kept.map((l) => ({ ...l, h: l.rect.h })),
      image.width,
    );
    const words: PxWord[] = [];
    ordered.forEach(({ item, block }, lineNo) => {
      for (const w of splitWords(item)) words.push({ ...w, line: lineNo, block });
    });
    lap('words');
    return { words, ms };
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
      // Class 0 is the CTC blank; a class past the dictionary is the space PaddleOCR appends.
      if (best !== 0 && best !== prev) chars.push({ ch: best - 1 < this.dict.length ? this.dict[best - 1]! : ' ', t0: s, t1: s, p: bv });
      else if (best !== 0 && best === prev && chars.length) chars[chars.length - 1]!.t1 = s;
      prev = best;
    }
    const text = chars.map((c) => c.ch).join('');
    const confidence = chars.length ? chars.reduce((a, c) => a + c.p, 0) / chars.length : 0;
    return { rect: crop.rect, box: crop.box, text, confidence, chars, recW, stepPx };
  }
}

/** The words of one recognised line, with boxes from the CTC time steps (time-step centres → x along the line's own axis). */
function splitWords(line: RecLine): Omit<PxWord, 'line' | 'block'>[] {
  const { chars, rect, recW, stepPx } = line;
  if (!chars.length) return [];
  const groups: { ch: string; t0: number; t1: number; p: number }[][] = [[]];
  for (const c of chars) {
    if (c.ch === ' ' || c.ch === '　') groups.push([]);
    else groups[groups.length - 1]!.push(c);
  }
  const lineW = rect.w;
  const toLineX = (t: number) => Math.max(0, Math.min(lineW, ((t * stepPx) / recW) * lineW));
  const all = chars.filter((c) => c.ch !== ' ');
  const centre = (c: { t0: number; t1: number }) => (c.t0 + c.t1 + 1) / 2;
  const pitch = all.length > 1 ? (centre(all[all.length - 1]!) - centre(all[0]!)) / (all.length - 1) : 2;
  const out: Omit<PxWord, 'line' | 'block'>[] = [];
  for (const g of groups) {
    if (!g.length) continue;
    const first = g[0]!;
    const last = g[g.length - 1]!;
    const wordPitch = g.length > 1 ? (centre(last) - centre(first)) / (g.length - 1) : pitch;
    const half = Math.min(wordPitch, pitch * 1.6) / 2;
    const x0 = toLineX(centre(first) - half);
    const x1 = toLineX(centre(last) + half);
    const pts = [
      [x0, 0],
      [x1, 0],
      [x1, rect.h],
      [x0, rect.h],
    ].map(([u, v]) => ({
      x: rect.cx + (u! - rect.w / 2) * rect.ux + (v! - rect.h / 2) * rect.vx,
      y: rect.cy + (u! - rect.w / 2) * rect.uy + (v! - rect.h / 2) * rect.vy,
    }));
    const xs = pts.map((q) => q.x);
    const ys = pts.map((q) => q.y);
    out.push({
      text: g.map((c) => c.ch).join(''),
      box: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
      confidence: g.reduce((a, c) => a + c.p, 0) / g.length,
    });
  }
  return out;
}
