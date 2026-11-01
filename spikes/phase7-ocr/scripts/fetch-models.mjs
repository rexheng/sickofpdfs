// Downloads the OCR models the bake-off needs into models/ (gitignored; nothing over a few MB is committed).
//   node scripts/fetch-models.mjs            download what is missing, check sha256 against models.manifest.json
//   node scripts/fetch-models.mjs --pin      also (re)write the manifest from what was downloaded
// Sources (all downloaded at build/run time by this script, never by the OCR code under test):
//   PP-OCRv5 / PP-OCRv6 ONNX exports   huggingface.co/PaddlePaddle/<repo>  (Apache-2.0), pinned to a commit
//   Tesseract "fast" and "best" data    raw.githubusercontent.com/tesseract-ocr/tessdata_{fast,best}  (Apache-2.0), pinned to a commit
// The pinned commits and the sha256 of every file live in models.manifest.json.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST = join(root, 'models.manifest.json');
const pin = process.argv.includes('--pin');

const HF = [
  'PP-OCRv5_mobile_det_onnx', 'PP-OCRv5_mobile_rec_onnx', 'latin_PP-OCRv5_mobile_rec_onnx', 'en_PP-OCRv5_mobile_rec_onnx',
  'PP-OCRv6_tiny_det_onnx', 'PP-OCRv6_small_det_onnx', 'PP-OCRv6_medium_det_onnx',
  'PP-OCRv6_tiny_rec_onnx', 'PP-OCRv6_small_rec_onnx', 'PP-OCRv6_medium_rec_onnx',
];
const TESS = [
  ['fast', 'eng'], ['fast', 'fra'], ['fast', 'deu'], ['best', 'eng'], ['best', 'fra'], ['best', 'deu'],
];

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8').catch(() => '{"files":{}}'));
manifest.files ??= {};
manifest.revisions ??= {};

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** @returns {Promise<{ path: string, url: string }[]>} */
async function plan() {
  const jobs = [];
  for (const repo of HF) {
    manifest.revisions[`hf:${repo}`] ??= (await json(`https://huggingface.co/api/models/PaddlePaddle/${repo}`)).sha;
    const rev = manifest.revisions[`hf:${repo}`];
    for (const f of ['inference.onnx', 'inference.yml'])
      jobs.push({ path: `ppocr/${repo.replace(/_onnx$/, '')}/${f}`, url: `https://huggingface.co/PaddlePaddle/${repo}/resolve/${rev}/${f}` });
  }
  for (const [kind, lang] of TESS) {
    const repo = `tessdata_${kind}`;
    if (!manifest.revisions[`gh:${repo}`]) {
      const c = await json(`https://api.github.com/repos/tesseract-ocr/${repo}/commits/main`).catch(() => null);
      // api.github.com may be unreachable from a sandbox: fall back to the moving branch and say so in the manifest.
      manifest.revisions[`gh:${repo}`] = c?.sha ?? 'main';
    }
    const rev = manifest.revisions[`gh:${repo}`];
    jobs.push({ path: `tessdata_${kind}/${lang}.traineddata`, url: `https://raw.githubusercontent.com/tesseract-ocr/${repo}/${rev}/${lang}.traineddata` });
  }
  return jobs;
}

async function sha256(file) {
  const h = createHash('sha256');
  await pipeline((await import('node:fs')).createReadStream(file), h);
  return h.digest('hex');
}

let bytes = 0;
for (const job of await plan()) {
  const dest = join(root, 'models', job.path);
  await mkdir(dirname(dest), { recursive: true });
  const have = await stat(dest).catch(() => null);
  if (!have) {
    const res = await fetch(job.url);
    if (!res.ok || !res.body) throw new Error(`${job.url}: HTTP ${res.status}`);
    const tmp = `${dest}.part`;
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    await rename(tmp, dest);
  }
  const size = (await stat(dest)).size;
  const hash = await sha256(dest);
  const known = manifest.files[job.path];
  if (known && known.sha256 !== hash) throw new Error(`${job.path}: sha256 ${hash} does not match the manifest (${known.sha256})`);
  if (!known || pin) manifest.files[job.path] = { sha256: hash, bytes: size, url: job.url };
  bytes += size;
  console.log(`${have ? 'ok      ' : 'fetched '}${job.path}  ${(size / 2 ** 20).toFixed(2)} MiB`);
}
await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
console.log(`models/: ${(bytes / 2 ** 20).toFixed(1)} MiB; manifest written`);
