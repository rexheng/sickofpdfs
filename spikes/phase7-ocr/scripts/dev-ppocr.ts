// Dev harness (Node, onnxruntime-web WASM): runs the PP-OCR pipeline on a PGM page and prints text + timings.
//   node scripts/dev-ppocr.ts <page.pgm> [v6-tiny|v6-small|v6-medium|v5-mobile|v5-latin|v5-en] [detMaxSide]
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';
import { PpOcr } from '../src/ocr/ppocr.ts';
import type { RgbaImage } from '../src/ocr/types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

export function readPgm(buf: Buffer): RgbaImage {
  // P5 <w> <h> <max>\n<bytes>
  let pos = 0;
  const tok = () => {
    while (/\s/.test(String.fromCharCode(buf[pos]!))) pos++;
    let s = '';
    while (!/\s/.test(String.fromCharCode(buf[pos]!))) s += String.fromCharCode(buf[pos++]!);
    return s;
  };
  if (tok() !== 'P5') throw new Error('not a P5 pgm');
  const width = Number(tok());
  const height = Number(tok());
  tok();
  pos++;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const g = buf[pos + i]!;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = g;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

export const SETS: Record<string, [string, string]> = {
  'v6-tiny': ['PP-OCRv6_tiny_det', 'PP-OCRv6_tiny_rec'],
  'v6-small': ['PP-OCRv6_small_det', 'PP-OCRv6_small_rec'],
  'v6-medium': ['PP-OCRv6_medium_det', 'PP-OCRv6_medium_rec'],
  'v5-mobile': ['PP-OCRv5_mobile_det', 'PP-OCRv5_mobile_rec'],
  'v5-latin': ['PP-OCRv5_mobile_det', 'latin_PP-OCRv5_mobile_rec'],
  'v5-en': ['PP-OCRv5_mobile_det', 'en_PP-OCRv5_mobile_rec'],
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [page, set = 'v6-tiny', maxSide = '1280'] = process.argv.slice(2);
  const [det, rec] = SETS[set]!;
  const r = (p: string) => readFile(`${root}models/ppocr/${p}`);
  ort.env.wasm.numThreads = 1;
  const engine = new PpOcr({
    id: set,
    ort,
    detModel: new Uint8Array(await r(`${det}/inference.onnx`)),
    recModel: new Uint8Array(await r(`${rec}/inference.onnx`)),
    detYml: (await r(`${det}/inference.yml`)).toString('utf8'),
    recYml: (await r(`${rec}/inference.yml`)).toString('utf8'),
    backend: 'wasm',
    detMaxSide: Number(maxSide),
  });
  await engine.init();
  console.log(JSON.stringify(engine.info()));
  const img = readPgm(await readFile(page!));
  for (let run = 0; run < 2; run++) {
    const t = performance.now();
    const words = await engine.recognize(img);
    console.log(`run ${run}: ${words.length} words in ${(performance.now() - t).toFixed(0)} ms`, JSON.stringify(engine.lastTimings(), (k, v) => (typeof v === 'number' ? Math.round(v) : v)));
    if (run === 1) {
      let line = -1;
      let text = '';
      for (const w of words) {
        if (w.line !== line) {
          text += '\n';
          line = w.line;
        }
        text += w.text + ' ';
      }
      console.log(text);
    }
  }
}
