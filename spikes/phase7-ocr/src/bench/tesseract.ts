// Tesseract.js 7 adapter behind OcrEngine. Runs where Tesseract.js is meant to run: created from the page (the
// offscreen document in the product); it starts its own worker. No CDN: worker, core and language data are extension files.
import { createWorker, type Worker as TessWorker } from 'tesseract.js';
import type { OcrEngine, OcrWord, RecognizeTimings, RgbaImage } from '../ocr/types.ts';
import type { TesseractConfig } from './config.ts';

/** 24-bit uncompressed BMP: the cheapest encoding Leptonica reads, so the measurement is not dominated by PNG encoding. */
export function rgbaToBmp(img: RgbaImage): Uint8Array {
  const { width: w, height: h, data } = img;
  const rowBytes = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + rowBytes * h;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  v.setUint32(2, size, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, w, true);
  v.setInt32(22, h, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);
  v.setUint32(34, rowBytes * h, true);
  v.setInt32(38, 11811, true);
  v.setInt32(42, 11811, true);
  for (let y = 0; y < h; y++) {
    let o = 54 + (h - 1 - y) * rowBytes;
    let i = y * w * 4;
    for (let x = 0; x < w; x++, i += 4) {
      out[o++] = data[i + 2]!;
      out[o++] = data[i + 1]!;
      out[o++] = data[i]!;
    }
  }
  return out;
}

export class TesseractEngine implements OcrEngine {
  readonly id: string;
  private worker!: TessWorker;
  private timings: RecognizeTimings = {};
  private facts: Record<string, unknown> = {};

  constructor(
    private cfg: TesseractConfig,
    private base: string,
  ) {
    this.id = cfg.id;
  }

  async init() {
    const t0 = performance.now();
    this.worker = await createWorker(this.cfg.langs, 1, {
      workerPath: `${this.base}tess/worker.min.js`,
      corePath: `${this.base}tess/`,
      langPath: `${this.base}models/tessdata_${this.cfg.data}`,
      workerBlobURL: false, // blob: workers are refused by the extension CSP
      gzip: false,
      cacheMethod: 'none',
      logger: () => {},
    });
    this.facts = { langs: this.cfg.langs, data: this.cfg.data, initMs: Math.round(performance.now() - t0) };
  }

  lastTimings() {
    return this.timings;
  }
  info() {
    return this.facts;
  }
  async dispose() {
    await this.worker?.terminate();
  }

  async recognize(image: RgbaImage): Promise<OcrWord[]> {
    let t = performance.now();
    const bmp = rgbaToBmp(image);
    const encode = performance.now() - t;
    t = performance.now();
    const { data } = await this.worker.recognize(bmp as unknown as Buffer, {}, { blocks: true });
    const recognize = performance.now() - t;
    t = performance.now();
    const words: OcrWord[] = [];
    let line = 0;
    (data.blocks ?? []).forEach((block, b) => {
      for (const para of block.paragraphs)
        for (const ln of para.lines) {
          for (const w of ln.words) {
            if (!w.text.trim()) continue;
            words.push({
              text: w.text,
              box: { x: w.bbox.x0, y: w.bbox.y0, width: w.bbox.x1 - w.bbox.x0, height: w.bbox.y1 - w.bbox.y0 },
              confidence: w.confidence / 100,
              line,
              block: b,
            });
          }
          line++;
        }
    });
    this.timings = { encode, recognize, post: performance.now() - t, total: encode + recognize + (performance.now() - t) };
    return words;
  }
}
