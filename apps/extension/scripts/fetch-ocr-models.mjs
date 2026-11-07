// `node scripts/fetch-ocr-models.mjs` (part of `pnpm assets`, so the start of `build` and `build:e2e`): puts the text
// recognition models for scanned pages (Phase 7, PP-OCRv6 tiny: a text detector and a line recogniser) in
// apps/extension/public/models/ocr/ (gitignored), which WXT copies into the build as models/ocr/. The OCR worker reads them
// with fetch() of chrome.runtime.getURL('models/ocr/…'); nothing is downloaded when the extension runs.
//
// The models are PaddlePaddle's own ONNX exports of PP-OCRv6 tiny (Apache-2.0), each at one pinned commit of its Hugging Face
// repository (the same commits the Phase 7.0 bake-off measured, docs/spikes/phase7-ocr-report.md). Only this script goes to the
// network, only at build time, only to huggingface.co, and every file is checked against the size and sha256 written below
// before it is kept: a file that does not match is deleted and the script exits 1. A file already in place with the right hash
// is left alone, so a build without a connection works after the first one.
//
// Offline copy: `SOP_OCR_MODELS_SRC=<folder>` takes the files from <folder>/<model>/<file> when they are there (checked the same way).
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

/** One entry per model folder: its Hugging Face repository, the pinned commit, and its two files. */
export const OCR_MODELS = [
  {
    dir: 'PP-OCRv6_tiny_det',
    repo: 'PaddlePaddle/PP-OCRv6_tiny_det_onnx',
    commit: '2ba1506c0380b8f0b03dd142459aac66d4421f6c',
    files: [
      { name: 'inference.onnx', bytes: 1780590, sha256: '193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8' },
      { name: 'inference.yml', bytes: 883, sha256: '3ac018be6f97499a08faa3bbdeb33640968d9307f6736d152902747a9f259593' },
    ],
  },
  {
    dir: 'PP-OCRv6_tiny_rec',
    repo: 'PaddlePaddle/PP-OCRv6_tiny_rec_onnx',
    commit: '2612ab37152ae0a677521bae4e1e3d4fb4cf7c30',
    files: [
      { name: 'inference.onnx', bytes: 4462639, sha256: '9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6' },
      { name: 'inference.yml', bytes: 55571, sha256: '66170210bad538e83fff3c4a3867e547d6bf20b50d64b20347c4b913f3034ea1' },
    ],
  },
  // The layout model (Phase 7.4): finds figures, tables and charts on a scanned page. PaddlePaddle publishes PP-DocLayout-S only
  // as Paddle files; this is a paddle2onnx export of it (Apache-2.0, 4.7 MiB), the smallest layout model that works.
  {
    dir: 'PP-DocLayout-S',
    kind: 'layout',
    repo: 'stefanj0/PP-DocLayout-S-ONNX',
    commit: '7e851b9e5ad66613d7318a3213ab3336ebe0a514',
    files: [{ name: 'pp_doclayout_s.onnx', bytes: 4917852, sha256: '33688dbee1c23e34b81777e97cb428eb40f24b242c02b5f623484959e830aec8' }],
  },
];

const out = fileURLToPath(new URL('../public/models/ocr/', import.meta.url));
const RETRIES = 3;

const NOTICE = `PP-OCRv6 tiny (text detection and text line recognition) and PP-DocLayout-S (figure, table and chart finding), ONNX exports
Licence: Apache-2.0 (https://www.apache.org/licenses/LICENSE-2.0).
${OCR_MODELS.map((m) => `Source: https://huggingface.co/${m.repo}/tree/${m.commit}\nFiles: ${m.files.map((f) => `${m.dir}/${f.name} (sha256 ${f.sha256})`).join('; ')}`).join('\n')}
Used for: reading the text of scanned pages and finding their figures. It runs on this computer only; nothing is sent anywhere.
`;

async function sha256Of(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function matches(file, path) {
  try {
    return (await stat(path)).size === file.bytes && (await sha256Of(path)) === file.sha256;
  } catch {
    return false;
  }
}

async function download(model, file, to) {
  const url = `https://huggingface.co/${model.repo}/resolve/${model.commit}/${file.name}`;
  const part = `${to}.part`;
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'sickofpdfs-build/0' } });
    if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status} from ${url}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
    if (!(await matches(file, part))) throw new Error(`${model.dir}/${file.name}: the download does not match the pinned size and sha256`);
    await rename(part, to);
  } finally {
    await rm(part, { force: true });
  }
}

/** Fills apps/extension/public/models/ocr/. Rejects when a file cannot be fetched or does not match its sha256. */
export default async function fetchOcrModels() {
  const local = process.env.SOP_OCR_MODELS_SRC || null;
  const how = { kept: 0, copied: 0, downloaded: 0 };
  for (const model of OCR_MODELS) {
    await mkdir(join(out, model.dir), { recursive: true });
    for (const file of model.files) {
      const to = join(out, model.dir, file.name);
      if (await matches(file, to)) {
        how.kept++;
        continue;
      }
      const from = local && join(local, model.dir, file.name);
      if (from && existsSync(from) && (await matches(file, from))) {
        await copyFile(from, to);
        how.copied++;
        continue;
      }
      let lastError = null;
      for (let attempt = 1; attempt <= RETRIES; attempt++) {
        try {
          await download(model, file, to);
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
      if (lastError) throw new Error(`cannot fetch ${model.dir}/${file.name}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
      how.downloaded++;
    }
  }
  await writeFile(join(out, 'NOTICE.txt'), NOTICE);
  const files = OCR_MODELS.flatMap((m) => m.files);
  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  console.log(`ocr models: ${files.length} files, ${(bytes / 2 ** 20).toFixed(1)} MiB in apps/extension/public/models/ocr/ (${how.kept} kept, ${how.copied} copied, ${how.downloaded} downloaded)`);
}

// Run as a script (`node scripts/fetch-ocr-models.mjs`), not when imported.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await fetchOcrModels();
  } catch (err) {
    console.error(`fetch-ocr-models: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
